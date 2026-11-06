import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import {
  bindOverlayShortcuts,
  closeOverlay,
  registerOverlay,
  type OverlayShortcuts
} from './overlay'
import { cancelPendingCapture, registerCapture } from './capture'
import { log, startLogging } from './log'
import {
  appDescription,
  foregroundApp,
  registerProcessAudio,
  startKeyWatch,
  stopKeyWatch,
  stopProcessAudio
} from './process-audio'
import { registerUpdaterIpc, startUpdater, stopUpdater } from './updater'

/**
 * Mirante — main process.
 *
 * Deliberately small. It owns the window, the capture picker bridge, and the
 * global hotkeys that a browser tab can never have — which is the entire
 * reason this is a desktop app and not a web page.
 */

// The source picker is 936px wide; the window must never open smaller than
// it plus the scrim padding, or the sheet opens clipped.
const MIN_WIDTH = 1024
const MIN_HEIGHT = 700

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
    // Frameless: the title bar is part of the design, not OS chrome.
    frame: false,
    // Matches --surface-base so there is no white flash before first paint.
    backgroundColor: '#0a0810',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => window.show())

  window.on('closed', () => {
    cancelPendingCapture()
    stopProcessAudio()
    mainWindow = null
  })

  // Window state -> renderer, so the custom title bar can swap its maximise icon.
  const emitState = (): void =>
    window.webContents.send('window:state', {
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen()
    })
  window.on('maximize', emitState)
  window.on('unmaximize', emitState)
  window.on('enter-full-screen', emitState)
  window.on('leave-full-screen', emitState)

  // External links open in the real browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerWindowControls(): void {
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
}

/**
 * Global hotkeys. These keep working while a game has focus, which is the
 * whole point — you should never have to alt-tab out of a match to mute.
 */
function registerHotkeys(): void {
  const bind = (accelerator: string, channel: string): void => {
    const ok = globalShortcut.register(accelerator, () => {
      mainWindow?.webContents.send(channel)
    })
    if (!ok) console.warn(`[hotkey] could not register ${accelerator} (taken by another app)`)
  }

  bind('CommandOrControl+Shift+M', 'hotkey:toggle-mic')
  bind('CommandOrControl+Shift+S', 'hotkey:toggle-screen')
  bind('CommandOrControl+Shift+C', 'hotkey:toggle-camera')
}

/**
 * Read the room directory on the renderer's behalf.
 *
 * The renderer cannot do this itself, and deliberately so: its CSP leaves
 * `connect-src` closed to http and https, which is the only thing stopping
 * MediaPipe from POSTing usage logs to Google on every camera background.
 * Opening it for one GET would hand that telemetry its channel back.
 *
 * Here there is no CSP and no CORS, and the signalling host is the only
 * address this ever asks for.
 */
function registerLobby(): void {
  ipcMain.handle('lobby:read', async (_event, url: string): Promise<unknown | null> => {
    if (!/^https?:\/\//i.test(url)) return null
    try {
      const response = await fetch(url, {
        // A server that is down must not leave the entrance saying
        // "looking" until someone gives up and closes the app.
        signal: AbortSignal.timeout(5000)
      })
      if (!response.ok) return null
      return await response.json()
    } catch {
      // Unreachable is a normal state here, not an error worth logging
      // every four seconds for as long as someone leaves the app open.
      return null
    }
  })
}

interface Atividade {
  name: string
  icon: string | null
}

/**
 * Que programa esta em primeiro plano, com o icone dele.
 *
 * O icone sai de `app.getFileIcon`, que pergunta ao proprio Windows — o
 * mesmo desenho que aparece na barra de tarefas. Cacheado por caminho:
 * extrair icone toca o disco, e o caminho so muda quando a pessoa troca
 * de programa.
 */
function registerActivity(): void {
  const cache = new Map<string, Atividade>()

  /**
   * Nome de arquivo sem extensao, para quando o executavel nao traz o
   * campo de descricao. Muito jogo pequeno nao traz — e "Goals" ainda le
   * melhor que "Goals.exe".
   *
   * O caminho completo e `C:\Users\<nome-de-usuario>\...`, e esta
   * informacao e anunciada para a sala inteira: deixa-la entrar no
   * renderer significa que um descuido la vira o nome de usuario do
   * Windows de alguem aparecendo na tela dos amigos. O caminho e
   * necessario aqui, para pedir icone e descricao ao sistema, e nao e
   * necessario em lugar nenhum depois daqui.
   */
  const soONome = (caminho: string): string => {
    const arquivo = (caminho.split(/[\\/]/).pop() ?? caminho)
      .replace(/\.exe$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim()
    return arquivo.charAt(0).toUpperCase() + arquivo.slice(1)
  }

  ipcMain.handle('activity:foreground', async (): Promise<Atividade | null> => {
    const caminho = foregroundApp()
    if (!caminho) return null

    const guardado = cache.get(caminho)
    if (guardado) return guardado

    // A descricao e o nome amigavel quase sempre, e as vezes uma frase:
    // cmd.exe se descreve como "Processador de comandos do Windows". Uma
    // linha dessas numa lista de pessoas empurra tudo; passado o limite,
    // o nome do arquivo le melhor ("cmd").
    const arquivo = soONome(caminho)
    const descricao = appDescription(caminho)
    const name = descricao && descricao.length <= 24 ? descricao : arquivo
    let icon: string | null = null
    try {
      const img = await app.getFileIcon(caminho, { size: 'small' })
      icon = img.isEmpty() ? null : img.toDataURL()
    } catch {
      // Programa protegido, caminho sem permissao, ou um executavel sem
      // icone. O nome sozinho ainda vale.
    }

    const atividade: Atividade = { name, icon }
    cache.set(caminho, atividade)
    return atividade
  })
}

/**
 * Tecla de falar, com soltar.
 *
 * `globalShortcut` dispara ao pressionar e nunca ao soltar, entao serve
 * para alternar e nao para segurar. E segurar precisa funcionar com o JOGO
 * em foco, que e o ponto inteiro: push-to-talk que exige o app na frente e
 * um botao de mudo com passos a mais.
 *
 * O gancho nativo e so um relator. Qual tecla importa, e o que fazer com
 * ela, fica no renderer, onde o resto do estado do microfone ja vive.
 */
function registerPushToTalk(window: BrowserWindow): void {
  let watching = false

  ipcMain.handle('keys:watch', (): boolean => {
    if (watching) return true
    try {
      const ok = startKeyWatch((vk: number, down: boolean) => {
        if (!window.isDestroyed()) window.webContents.send('keys:event', vk, down)
      })
      if (!ok) return false
      watching = true
      log('keys', 'gancho de teclado ligado')
      return true
    } catch (error) {
      log('keys', 'nao consegui ligar o gancho:', String(error))
      return false
    }
  })

  ipcMain.handle('keys:unwatch', (): void => {
    if (!watching) return
    stopKeyWatch()
    watching = false
  })

  app.on('before-quit', () => {
    if (watching) stopKeyWatch()
  })
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.tvmirante.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  mainWindow = createWindow()
  startLogging(mainWindow)

  // AFTER the GPU process has actually reported, which takes around half a
  // second. Asked inside `whenReady` this returns the pre-initialisation
  // defaults — every feature `disabled_software` and no adapter active —
  // which reads exactly like a machine with acceleration switched off and
  // sent me chasing one that did not exist. `getGPUInfo('complete')`
  // resolves once the probe is done, so the status after it is the truth.
  void app
    .getGPUInfo('complete')
    .then((info) => {
      const gpu = app.getGPUFeatureStatus()
      const device = (info as { gpuDevice?: Array<{ active?: boolean }> }).gpuDevice?.find(
        (d) => d.active
      )
      const renderer =
        (info as { auxAttributes?: { glRenderer?: string } }).auxAttributes?.glRenderer ?? '?'
      log(
        'gpu',
        `video_encode=${gpu.video_encode} compositing=${gpu.gpu_compositing}`,
        `active=${device ? 'sim' : 'nao'}`,
        renderer
      )
    })
    .catch((error: unknown) => log('gpu', 'could not read:', String(error)))
  registerWindowControls()
  registerCapture()
  registerProcessAudio(mainWindow)
  registerLobby()
  registerActivity()
  registerPushToTalk(mainWindow)
  registerHotkeys()
  registerOverlay(mainWindow)
  ipcMain.handle('overlay:bind-shortcuts', (event, shortcuts: OverlayShortcuts) =>
    bindOverlayShortcuts(event.sender, shortcuts)
  )
  // The IPC surface always exists, so the renderer can ask about updates in
  // any build. Only a packaged build actually drives the updater — there is
  // no release feed to read from a dev tree.
  registerUpdaterIpc()
  if (app.isPackaged) startUpdater(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('will-quit', () => {
  closeOverlay()
  globalShortcut.unregisterAll()
  stopUpdater()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
