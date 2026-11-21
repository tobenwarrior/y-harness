/** Assign each owner Bot on a configured VPS its own shell, files and desktop. */

import type { Agent } from '@yharness/agent'
import type { Context } from '@yharness/cordis'
import type {} from '@yharness/api-terminal-controller'
import { LocalBashExecutor } from '@yharness/bash-local'
import { bindManagedBotExecution, createManagedBotExecution, managedBotExecutionFor } from '@yharness/sandbox-policy'
import { VpsBotSubprocess } from './vps-bot-process.ts'
import { VpsBotFileSystem } from './vps-bot-files.ts'
import type {} from '@yharness/bots'
import type { WorkspaceFileAccessProvider } from '@yharness/api-workspace-files'
import type {} from '@yharness/client-connection'
import type {} from '@yharness/system-prompt'
import { ComputerLeaseError, containerComputer, type VpsComputer } from './computer.ts'
import * as ComputerTool from './computer-tool.ts'
import {
  botComputerRoutesWithLegacy, computerFileDownloadRoute, computerFileHandoffRoutes, computerFileUploadRoute,
  computerRestartRoute, computerSettingRoute, computerSignInRoute,
} from './computer-api.ts'
import { registerVpsBotFileTools, VpsBotFileHandoffs } from './vps-bot-file-handoffs.ts'
import { resolveVpsFileUploadLimits, uploadComputerFile, type VpsFileUploadConfig } from './vps-bot-upload.ts'
import { SessionId } from '@yharness/session/types'
import { isVpsSharedPath, VpsRuntime, type VpsBrowserOptions } from './vps-runtime.ts'
import { VpsBotComputerSetting } from './vps-bot-computer-setting.ts'
import { registerVpsProjectTool } from './vps-project-tool.ts'
import { isSharedBrowserSession, runAuthorizedBrowserOperation, VpsIsolatedBrowser, type VpsIsolatedBrowserConfig } from './vps-isolated-browser.ts'
import { VpsBrowserRoster, type VpsBrowserRosterEntry } from './vps-browser-roster.ts'
import { VpsBrowserHandoffs } from './vps-browser-handoffs.ts'
import { vpsBrowserAccessRoute } from './vps-browser-access.ts'
import { type AutomaticVpsBrowserLogin, VpsBrowserLogin, type VpsBrowserLoginLease, vpsBrowserLoginRoute } from './vps-browser-login.ts'
import { registerVpsServiceTools, VpsServices, type VpsServiceAccess } from './vps-services.ts'
import { registerVpsJournalTool, VpsJournal, type VpsJournalConfig } from './vps-journal.ts'

const BINDING_UNAVAILABLE = 'The Bot’s VPS environment could not be bound to this Session.'
const guardedAgents = new WeakSet<Agent>()

const BOT_TOOLS = new Set([
  'bash', 'read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'present', 'job_output', 'job_list', 'job_kill',
  'vps_computer', 'copy_vps_file', 'read_vps_file', 'vps_project_files', 'vps_service_status', 'vps_service_restart', 'vps_service_journal', 'skill', 'search_skills',
  'request_vps_secret',
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update', 'schedule_pause', 'schedule_resume', 'schedule_history',
  'schedule_event_create', 'schedule_event_list', 'schedule_event_delete', 'schedule_event_update',
  'schedule_event_pause', 'schedule_event_resume', 'schedule_event_history',
  'ask_user_question', 'todo_write', 'get_goal', 'create_goal', 'update_goal', 'exit_plan_mode', 'web_search',
  'read_own_grok_history', 'list_bots', 'inspect_bot', 'send_bot_message', 'create_bot', 'edit_bot_profile',
  'list_bot_memory', 'remember_bot_memory', 'forget_bot_memory', 'list_connected_apps',
  'list_bot_groups', 'inspect_bot_group', 'create_bot_group', 'update_bot_group', 'send_bot_group_message',
])

function guardHostFallback(agent: Agent): void {
  if (guardedAgents.has(agent)) return
  agent.ctx.effect(() => {
    const dispose = agent.ctx.tools.guard(call => managedBotExecutionFor(call) === undefined ? BINDING_UNAVAILABLE : undefined)
    guardedAgents.add(agent)
    return () => {
      dispose()
      guardedAgents.delete(agent)
    }
  }, 'vps-bots: protect an unbound managed Agent')
}

/**
 * Mount managed Linux computers in the shipped VPS Web profile.
 * @param ctx - Web Host composition.
 * @param config - Runtime root, local desktop images, and Bot Computer selection.
 * @param grants - Exact operator-configured systemd grants.
 * @param legacyComputer - Existing shared controller used by Bots outside the allowlist.
 * @param journalConfig - Private socket and authorized Computer Bots.
 * @param automaticLogin - Private automatic account delivery through the installed Vault.
 */
export function mountVpsBots(
  ctx: Context,
  config: {
    readonly root: string
    readonly image: string
    readonly bots?: readonly string[] | null
    readonly desktopOnlyBots?: readonly string[]
    readonly desktopForUnlistedBots?: boolean
    readonly sharedWorkspace?: { readonly bots?: readonly string[] | null } | null
    readonly network?: { readonly bots: readonly string[] } | null
    readonly uploads?: VpsFileUploadConfig
    readonly browser?: (VpsBrowserOptions & { readonly bots: readonly string[] }) | null
    readonly isolatedBrowser?: VpsIsolatedBrowserConfig | null
  },
  grants: readonly VpsServiceAccess[],
  legacyComputer?: VpsComputer,
  journalConfig?: VpsJournalConfig,
  automaticLogin?: AutomaticVpsBrowserLogin,
): void {
  const uploadLimits = resolveVpsFileUploadLimits(config.uploads)
  const services = new VpsServices(grants)
  const browsers = new Map<string, VpsComputer>()
  const desktops = new Map<string, VpsComputer>()
  const pendingComputerStarts = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  const bindings = new Set<() => void | Promise<void>>()
  const attachments = new WeakMap<Agent, Promise<void>>()
  const previewFiles = new Map<string, VpsBotFileSystem>()
  const projectFiles = new Map<string, VpsBotFileSystem>()
  const importFiles = new Map<string, VpsBotFileSystem>()
  const managedBotIds = config.bots == null ? undefined : new Set(config.bots)
  const desktopOnlyBotIds = new Set(config.desktopOnlyBots ?? [])
  const isManagedBot = (botId: string): boolean => !desktopOnlyBotIds.has(botId)
    && (managedBotIds === undefined || managedBotIds.has(botId))
  if (managedBotIds !== undefined && [...desktopOnlyBotIds].some(botId => !managedBotIds.has(botId))) {
    throw new Error('Desktop-only VPS Bots must be selected by botComputers.bots.')
  }
  const isSelectedDesktop = (botId: string): boolean => isManagedBot(botId) || desktopOnlyBotIds.has(botId)
  const isDesktopBot = (botId: string): boolean => isSelectedDesktop(botId) || config.desktopForUnlistedBots === true
  const isDesktopOnly = (botId: string): boolean => isDesktopBot(botId) && !isManagedBot(botId)
  const sharedBotIds = config.sharedWorkspace?.bots == null ? undefined : new Set(config.sharedWorkspace.bots)
  if (sharedBotIds !== undefined && [...sharedBotIds].some(botId => !isDesktopBot(botId))) {
    throw new Error('Shared project access must select private Computer Bots.')
  }
  const sharesProject = (botId: string): boolean => config.sharedWorkspace != null && isDesktopBot(botId)
    && (sharedBotIds === undefined ? isSelectedDesktop(botId) : sharedBotIds.has(botId))
  const browserOptions = config.browser ?? undefined
  const browserBotIds = new Set(browserOptions?.bots)
  const networkBotIds = config.network == null ? undefined : new Set(config.network.bots)
  const isolatedBrowserBotIds = new Set(config.isolatedBrowser?.bots)
  const ownerRosterPath = config.isolatedBrowser?.ownerRosterPath
  const isIsolatedBrowserBot = (botId: string): boolean => isolatedBrowserBotIds.has(botId)
    || (ownerRosterPath !== undefined && isDesktopBot(botId) && !browserBotIds.has(botId))
  const hasBrowserSignIn = (botId: string): boolean => isIsolatedBrowserBot(botId)
    || (browserBotIds.has(botId) && isDesktopOnly(botId))
  if ([...browserBotIds].some(botId => !isDesktopBot(botId))) {
    throw new Error('VPS browser access must select private Computer Bots.')
  }
  if (networkBotIds !== undefined && [...networkBotIds].some(botId => !isDesktopBot(botId))) {
    throw new Error('VPS internet access must select private Computer Bots.')
  }
  if ([...isolatedBrowserBotIds].some(botId => !isDesktopBot(botId))) {
    throw new Error('VPS isolated browser access must select private Computer Bots.')
  }
  if ([...browserBotIds].some(botId => isolatedBrowserBotIds.has(botId))) {
    throw new Error('VPS browser and isolated browser Bots must not overlap.')
  }
  const networkPolicy = new VpsBotComputerSetting(config.root, 'network')
  const sharedWorkspacePolicy = config.sharedWorkspace === null ? undefined : new VpsBotComputerSetting(config.root, 'shared-workspace')
  const projectToolGrants = new Map<SessionId, (granted: boolean) => Promise<void>>()
  const runtimes = new Map<string, VpsRuntime>()
  const runtimeWith = (browser: VpsBrowserOptions | undefined, sharedWorkspace: boolean, internet: boolean): VpsRuntime => {
    lifetime.signal.throwIfAborted()
    const key = `${browser !== undefined}/${sharedWorkspace}/${internet}`
    let runtime = runtimes.get(key)
    if (runtime === undefined) {
      runtime = new VpsRuntime(config.root, config.image, undefined, {
        ...(browser === undefined ? {} : { browser }),
        configurationSignal: lifetime.signal, sharedWorkspace, internet, networkPolicy,
        ...(sharedWorkspacePolicy === undefined ? {} : { sharedWorkspacePolicy }),
      })
      runtimes.set(key, runtime)
    }
    return runtime
  }
  const defaultRuntime = runtimeWith(undefined, false, false)
  if (config.sharedWorkspace != null) runtimeWith(undefined, true, false)
  if (config.browser != null) runtimeWith(config.browser, false, networkBotIds === undefined)
  let browserRoster: VpsBrowserRoster | undefined
  if (ownerRosterPath !== undefined) {
    ctx.inject(['bots'], (scope) => {
      const roster = new VpsBrowserRoster(ownerRosterPath, async () => {
        const entries: VpsBrowserRosterEntry[] = []
        for (const row of (await scope.bots.list({ includeHidden: true })).bots) {
          if (row.state !== 'active' || !isIsolatedBrowserBot(row.id)) continue
          const owner = await scope.bots.ownerBotForSession(row.sessionId)
          if (owner?.state === 'active' && owner.id === row.id && owner.sessionId === row.sessionId) {
            entries.push({ bot: owner.id, session: owner.sessionId })
          }
        }
        return entries
      })
      const publish = (): void => {
        void roster.sync().catch((error: unknown) => {
          void error
          if (browserRoster === roster) scope.logger.warn('Could not publish private Bot browser assignments.')
        })
      }
      scope.effect(() => {
        browserRoster = roster
        publish()
        return async () => {
          /* v8 ignore else -- bots-injection teardown ordering awaits this roster disposer before reloading a replacement provider. */
          if (browserRoster === roster) browserRoster = undefined
          await roster.close()
        }
      }, 'vps-bots: publish private browser assignments')
      scope.on('bots/changed', () => { roster.invalidate(); publish() })
    })
  }
  const isolatedBrowser = config.isolatedBrowser == null
    ? undefined
    : new VpsIsolatedBrowser(config.isolatedBrowser, ownerRosterPath === undefined ? undefined : {
      prepare: async () => {
        if (browserRoster === undefined) throw new Error('The isolated browser roster is unavailable.')
        try { await browserRoster.sync() }
        catch (error) { void error; throw new Error('The isolated browser roster is unavailable.') }
      },
    })
  const browserLogin = isolatedBrowser === undefined || config.isolatedBrowser?.savedLogins !== true
    ? undefined
    : new VpsBrowserLogin(isolatedBrowser, automaticLogin === undefined ? undefined : { automaticLogin })
  const browserHandoffs = isolatedBrowser === undefined
    || (!isolatedBrowser.usesManagedSharing() && !config.isolatedBrowser?.sharedBots?.length)
    ? undefined
    : new VpsBrowserHandoffs(isolatedBrowser)
  if (isolatedBrowser !== undefined && browserHandoffs !== undefined) {
    ctx.provide('botSharedBrowser', {
      available: (botId, sessionId, ownerSessionId, signal) =>
        isIsolatedBrowserBot(botId)
          ? isolatedBrowser.availableInSharedSession(botId, sessionId, ownerSessionId, signal)
          : Promise.resolve(false),
      toolForSession(scope, agent, botId, authorized, ownerSessionId) {
        const sessionId = agent.id
        if (!isSharedBrowserSession(sessionId) || !isIsolatedBrowserBot(botId)
          || !isolatedBrowser.authorized(botId, sessionId)) return undefined
        if (scope.get('attachments') === undefined || scope.get('llm') === undefined) {
          throw new Error('The shared browser requires attachment and model services.')
        }
        const computer = isolatedBrowser.computer(botId, sessionId, authorized)
        scope.effect(() => () => computer.dispose(), 'vps-bots: shared browser controls')
        return ComputerTool.sharedVpsBrowserTool(
          scope,
          computer,
          async (caller, signal) => caller === agent && await authorized(signal),
          (_sessionId, url, signal) => computer.navigateAsBot(url, signal, (target, operationSignal) =>
            runAuthorizedBrowserOperation(authorized,
              () => isolatedBrowser.navigate(botId, sessionId, target, operationSignal), operationSignal)),
          browserLogin === undefined ? undefined : (_caller, signal) => browserLogin.request(botId, sessionId,
            (operation, requestSignal) => computer.runWhileBotControls(operation, requestSignal), signal, authorized),
          ownerSessionId === undefined ? undefined : (_caller, signal) => browserHandoffs.request(
            botId, ownerSessionId, sessionId, computer, authorized, signal,
          ),
        )
      },
    })
    if (browserLogin !== undefined) {
      ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: '__YH_BOT_SHARED_BROWSER__', value: true })
      })
    }
  }
  if (ownerRosterPath !== undefined || isolatedBrowserBotIds.size > 0 || [...browserBotIds].some(hasBrowserSignIn)) {
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__YH_BOT_COMPUTER_SIGN_IN__', value: true })
    })
  }
  if (browserLogin !== undefined) {
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__YH_BOT_WEBSITE_LOGIN__', value: true })
    })
  }
  const runtimeFor = (botId: string): VpsRuntime => {
    const browser = browserBotIds.has(botId) ? browserOptions : undefined
    const internet = networkBotIds === undefined ? browser !== undefined : networkBotIds.has(botId)
    return runtimeWith(browser, sharesProject(botId), internet)
  }
  if (journalConfig?.bots.some(botId => !isDesktopBot(botId))) {
    throw new Error('VPS journal grants must select Computer Bots.')
  }
  const journal = journalConfig === undefined ? undefined : new VpsJournal(journalConfig)
  if (journal !== undefined) {
    ctx.provide('botVpsJournal', {
      forBot: botId => journal.authorized(botId)
        ? signal => journal.read(botId, AbortSignal.any([signal, lifetime.signal]))
        : undefined,
    })
  }
  ctx.provide('botWorkspaces', {
    workspace: sessionId => defaultRuntime.workspace(sessionId),
    prepare: (sessionId, botId, signal) => signal === undefined
      ? runtimeFor(botId).ensure(sessionId)
      : runtimeFor(botId).ensure(sessionId, signal),
    installSkill: async (sessionId, botId, name, content, preview, signal) => {
      if (!isManagedBot(String(botId))) throw new Error('Grok skills require a managed Bot workspace.')
      const key = String(sessionId)
      let files = importFiles.get(key)
      if (files === undefined) {
        await ctx.plugin((scope) => {
          const created = new VpsBotFileSystem(scope.isolate('fs'), runtimeFor(String(botId)), sessionId)
          importFiles.set(key, created)
          return () => {
            /* v8 ignore else -- Cordis disposes this child before the owning mount can clear its cache. */
            if (importFiles.get(key) === created) importFiles.delete(key)
          }
        })
        files = importFiles.get(key)
      }
      if (files === undefined) throw new Error('The managed Bot workspace filesystem was not initialized.')
      return files.installSkill(name, content, preview, signal)
    },
    managed: (botId: string) => isManagedBot(botId),
    desktopOnly: isDesktopOnly,
  })
  ctx.effect(() => async () => {
    lifetime.abort(new Error('VPS Bot Computer scope is closed'))
    const active = [...browsers.values(), ...desktops.values()]
    browsers.clear()
    desktops.clear()
    previewFiles.clear()
    projectFiles.clear()
    importFiles.clear()
    const preparations = Promise.allSettled(pendingComputerStarts)
    // Terminal bindings close their container process groups before the runtime stops.
    const unbound = await Promise.allSettled([
      ...[...bindings].map(dispose => Promise.resolve().then(dispose)),
      browserLogin?.dispose(),
      browserHandoffs?.dispose(),
    ])
    const stopped = await Promise.allSettled([
      ...[...runtimes.values()].map(runtime => runtime.dispose()),
      ...active.map(computer => computer.dispose()),
      preparations,
    ])
    const errors = [...unbound, ...stopped]
      .filter(result => result.status === 'rejected')
      .map((result): unknown => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'The VPS Bot configuration could not close.')
  }, 'vps-bots: dispose Agent bindings and desktop controllers')

  const bind = async (
    agent: Agent,
    services: Parameters<Context['inject']>[0],
    install: (agentCtx: Context) => void | Promise<void>,
  ): Promise<void> => {
    lifetime.signal.throwIfAborted()
    const fiber = agent.ctx.inject(services, (agentCtx) => {
      lifetime.signal.throwIfAborted()
      return install(agentCtx)
    })
    const dispose = agent.ctx.effect(() => async () => {
      try {
        await fiber.dispose()
      } finally {
        bindings.delete(dispose)
      }
    }, 'vps-bots: dispose an Agent binding')
    bindings.add(dispose)
    try {
      await fiber
      lifetime.signal.throwIfAborted()
    } catch (error) {
      await dispose()
      throw error
    }
  }

  const requireOpenComputerScope = (signal: AbortSignal): void => {
    signal.throwIfAborted()
    if (lifetime.signal.aborted) throw new ComputerLeaseError('The Bot Computer is closing.')
  }

  const openComputer = async (
    controllers: Map<string, VpsComputer>,
    sessionId: string,
    signal: AbortSignal,
    prepare: () => Promise<unknown>,
    create: () => VpsComputer,
  ): Promise<VpsComputer> => {
    requireOpenComputerScope(signal)
    const preparation = prepare()
    pendingComputerStarts.add(preparation)
    try {
      await preparation
      requireOpenComputerScope(signal)
      const existing = controllers.get(sessionId)
      if (existing !== undefined) return existing
      const controller = create()
      controllers.set(sessionId, controller)
      return controller
    } finally {
      pendingComputerStarts.delete(preparation)
    }
  }

  const desktopFor = (sessionId: string, botId: string, signal: AbortSignal): Promise<VpsComputer> => {
    const runtime = runtimeFor(botId)
    return openComputer(desktops, sessionId, signal,
      () => runtime.ensure(sessionId),
      () => containerComputer((argv, requestSignal, stdin) => runtime.desktopCommand(sessionId, argv, requestSignal, stdin)))
  }

  const computerFor = (sessionId: string, botId: string, signal: AbortSignal): Promise<VpsComputer> => {
    if (isolatedBrowser === undefined || !isIsolatedBrowserBot(botId)) return desktopFor(sessionId, botId, signal)
    const requestSignal = AbortSignal.any([signal, lifetime.signal])
    return openComputer(browsers, sessionId, requestSignal,
      () => isolatedBrowser.status(botId, sessionId, requestSignal),
      () => isolatedBrowser.computer(botId, sessionId))
  }
  const navigateFor = async (botId: string, sessionId: string, url: string, signal: AbortSignal): Promise<void> => {
    /* v8 ignore if -- the only receiver installs this callback after the immutable isolated-browser admission check. */
    if (isolatedBrowser === undefined || !isIsolatedBrowserBot(botId)) {
      throw new Error('Browser navigation is unavailable for this Bot.')
    }
    const computer = await computerFor(sessionId, botId, signal)
    await computer.navigateAsBot(url, signal, (targetUrl, targetSignal) => isolatedBrowser.navigate(
      botId, sessionId, targetUrl, targetSignal,
    ))
  }
  const browserNavigateFor = (botId: string, sessionId: string): ((url: string, signal: AbortSignal) => Promise<void>) | undefined => {
    if (isolatedBrowser === undefined || !isIsolatedBrowserBot(botId)) return undefined
    return (url, signal) => isolatedBrowser.navigate(botId, sessionId, url, signal)
  }

  const filesFor = (
    scope: Context, allowed: (botId: string) => boolean,
  ): NonNullable<WorkspaceFileAccessProvider['forComputer']> => async (sessionId, signal, path) => {
    signal.throwIfAborted()
    const bot = await scope.bots.ownerBotForSession(sessionId)
    signal.throwIfAborted()
    if (bot === undefined || !allowed(bot.id)) return undefined
    if (bot.state !== 'active') throw new Error('The Bot workspace is not ready.')
    const runtime = runtimeFor(bot.id)
    const privateRoot = runtime.workspace(sessionId)
    const shared = path !== undefined && isVpsSharedPath(path, privateRoot)
    const workspaceRoot = shared ? await runtime.sharedWorkspaceFor(sessionId) : privateRoot
    if (workspaceRoot === undefined) return undefined
    const files = shared ? projectFiles : previewFiles
    let fs = files.get(sessionId)
    if (fs === undefined) {
      fs = new VpsBotFileSystem(scope.isolate('fs'), runtime, sessionId, shared ? 'shared' : 'private')
      files.set(sessionId, fs)
    }
    return { fs, workspaceRoot }
  }
  ctx.inject(['bots'], (scope) => {
    scope.provide('workspaceFileAccess', {
      forSession: filesFor(scope, isManagedBot),
      forComputer: filesFor(scope, isDesktopBot),
    })
  })

  ctx.inject(['bots', 'connection'], (scope) => {
    const maintain = async <T extends 'applied' | 'restarted'>(
      sessionId: SessionId, signal: AbortSignal, work: (botId: string) => Promise<T | 'busy' | undefined> | undefined,
    ): Promise<T | 'busy' | undefined> => {
      const bot = await scope.bots.ownerBotForSession(sessionId)
      if (bot?.state !== 'active' || bot.sessionId !== sessionId || !isDesktopBot(bot.id)) return undefined
      const apply = async (): Promise<T | 'busy' | undefined> => {
        if (scope.get('agents')?.get(sessionId)?.status === 'running'
          || scope.get('terminalController')?.list(sessionId).some(terminal => terminal.state === 'running')
          || browserLogin?.hasPending(sessionId) === true) return 'busy'
        return work(bot.id)
      }
      const holdDesktop = (): Promise<T | 'busy' | undefined> => {
        const desktop = desktops.get(sessionId)
        return desktop === undefined ? apply() : desktop.runWhileBotControls(apply, signal)
      }
      const browser = browsers.get(sessionId)
      try {
        return browser === undefined ? await holdDesktop() : await browser.runWhileBotControls(holdDesktop, signal)
      } catch (error) {
        if (error instanceof ComputerLeaseError) return 'busy'
        throw error
      }
    }
    scope.effect(() => scope.connection.fetch.register(computerSettingRoute('network', (sessionId, enabled, signal) =>
      maintain(sessionId, signal, botId => runtimeFor(botId).setInternetAccess(sessionId, enabled, signal)),
    )), 'vps-bots: owner Computer internet setting')
    scope.effect(() => scope.connection.fetch.register(computerRestartRoute((sessionId, surface, signal) =>
      maintain(sessionId, signal, (botId) => {
        const hasIsolatedBrowser = isIsolatedBrowserBot(botId)
        if (surface === 'desktop' && !hasIsolatedBrowser) return undefined
        if (surface === 'primary' && hasIsolatedBrowser && isolatedBrowser !== undefined) {
          return isolatedBrowser.restart(botId, sessionId, signal)
        }
        return runtimeFor(botId).restart(sessionId, signal)
      }),
    )), 'vps-bots: owner Computer restart')
    if (isolatedBrowser?.usesManagedSharing() === true) {
      scope.effect(() => scope.connection.fetch.register(vpsBrowserAccessRoute(scope, isolatedBrowser)), 'vps-bots: owner browser access')
    }
    scope.inject(['workspaceFiles'], (filesScope) => {
      if (sharedWorkspacePolicy !== undefined) {
        filesScope.effect(() => filesScope.connection.fetch.register(computerSettingRoute('shared-workspace', (sessionId, enabled, signal) =>
          maintain(sessionId, signal, async (botId) => {
            const runtime = runtimeFor(botId)
            if (!runtime.supportsSharedWorkspaceControl()) return undefined
            const result = await runtime.setSharedWorkspaceAccess(sessionId, enabled, signal)
            if (result === 'applied') await projectToolGrants.get(sessionId)?.(enabled)
            return result
          }),
        )), 'vps-bots: owner shared workspace setting')
      }
      filesScope.effect(() => filesScope.connection.fetch.register(computerFileDownloadRoute(
        (sessionId, path, signal) => filesScope.workspaceFiles.downloadComputer(SessionId(sessionId), path, signal),
      )), 'vps-bots: owner file downloads')
      filesScope.effect(() => filesScope.connection.fetch.register(computerFileUploadRoute(
        async (sessionId, file, signal) => {
          signal.throwIfAborted()
          const bot = await filesScope.bots.ownerBotForSession(SessionId(sessionId))
          if (bot?.state !== 'active' || !isDesktopBot(bot.id)) return undefined
          return uploadComputerFile(runtimeFor(bot.id), sessionId, file, uploadLimits, signal)
        }, uploadLimits.maxBytes,
      )), 'vps-bots: owner file uploads')
      const handoffs = new VpsBotFileHandoffs(filesScope, runtimeFor, isDesktopBot, uploadLimits)
      for (const route of computerFileHandoffRoutes(handoffs)) {
        filesScope.effect(() => filesScope.connection.fetch.register(route), 'vps-bots: owner file handoffs')
      }
    })
    if (browserLogin !== undefined) {
      scope.effect(() => scope.connection.fetch.register(vpsBrowserLoginRoute(scope, browserLogin)), 'vps-bots: owner saved-login metadata')
    }
    const ownedHandoff = async (target: string) => {
      const handoff = browserHandoffs?.target(target)
      if (handoff === undefined) return undefined
      const bot = await scope.bots.ownerBotForSession(handoff.ownerSessionId)
      if (bot?.state !== 'active' || bot.id !== handoff.botId || bot.sessionId !== handoff.ownerSessionId
        || browserHandoffs?.target(target) !== handoff) return undefined
      return handoff
    }
    scope.effect(() => scope.connection.fetch.register(computerSignInRoute(async (sessionId) => {
      if (sessionId.startsWith('handoff-')) return ownedHandoff(sessionId)
      const bot = await scope.bots.ownerBotForSession(sessionId)
      if (bot?.state !== 'active' || !hasBrowserSignIn(bot.id)) return undefined
      const computer = (isIsolatedBrowserBot(bot.id) ? browsers : desktops).get(sessionId)
      return {
        status: () => computer?.signInRequest() ?? browserHandoffs?.status(bot.id, bot.sessionId),
        answer: async (...args) => {
          if (computer === undefined) throw new Error('Computer sign-in request has ended.')
          return computer.answerSignIn(...args)
        },
      }
    })), 'vps-bots: owner sign-in handoff')
    for (const route of botComputerRoutesWithLegacy(async (sessionId) => {
      if (sessionId.startsWith('handoff-')) {
        const handoff = await ownedHandoff(sessionId)
        return handoff === undefined ? undefined : {
          computer: handoff.computer, id: handoff.botId, permissionScope: 'bot' as const, navigate: handoff.navigate,
        }
      }
      // Only an explicit allowlist rollout retains the old omitted-session
      // request as the shared legacy display. Fresh managed installations
      // require a Bot Session and fail closed in the route parser.
      if (sessionId === '' && managedBotIds !== undefined) {
        return legacyComputer === undefined
          ? undefined
          : { computer: legacyComputer, id: 'shared-vps', permissionScope: 'workspace' as const }
      }
      const bot = await scope.bots.ownerBotForSession(sessionId)
      if (bot?.state !== 'active') return undefined
      if (isDesktopBot(bot.id)) {
        const navigate = browserNavigateFor(bot.id, bot.sessionId)
        const isolated = isolatedBrowser !== undefined && isIsolatedBrowserBot(bot.id) ? isolatedBrowser : undefined
        const runtime = runtimeFor(bot.id)
        const internet = await runtime.internetFor(bot.sessionId)
        const files = scope.get('workspaceFiles') !== undefined
        const sharedFiles = files && await runtime.sharedWorkspaceFor(bot.sessionId) !== undefined
        return {
          computer: (signal: AbortSignal) => computerFor(bot.sessionId, bot.id, signal),
          ...(isolated === undefined ? {} : { desktop: (signal: AbortSignal) => desktopFor(bot.sessionId, bot.id, signal) }),
          id: bot.id,
          permissionScope: 'bot' as const,
          restart: isolated === undefined ? true as const
            : (signal: AbortSignal) => isolated.restartAvailable(bot.id, bot.sessionId, signal),
          ...(scope.get('terminalController') === undefined ? {} : {
            terminal: true as const, terminalInternet: internet,
            ...(runtime.supportsNetworkControl(internet) ? { networkControl: true as const } : {}),
          }),
          ...(files ? {
            files: true as const,
            ...(sharedFiles ? { sharedFiles: true as const } : {}),
            ...(runtime.supportsSharedWorkspaceControl() ? { sharedWorkspaceControl: true as const } : {}),
          } : {}),
          ...(navigate === undefined ? {} : { navigate }),
        }
      }
      if (legacyComputer === undefined) return undefined
      return { computer: legacyComputer, id: 'shared-vps', permissionScope: 'workspace' as const }
    }, { allowMissingSession: managedBotIds !== undefined })) {
      scope.effect(() => scope.connection.fetch.register(route), 'vps-bots: owner desktop route')
    }
  })

  ctx.inject(['bots'], (scope) => {
    scope.on('tools/pre-execute', async (call, next) => {
      const bot = call.agent === undefined ? undefined : await scope.bots.ownerBotForSession(call.agent.id)
      if (bot !== undefined && isManagedBot(bot.id) && managedBotExecutionFor(call) === undefined) {
        return { kind: 'deny', reason: BINDING_UNAVAILABLE }
      }
      return next()
    }, { prepend: true })
    const installAgent = async (agent: Agent, signal?: AbortSignal): Promise<void> => {
      const bot = await scope.bots.ownerBotForSession(agent.id)
      if (agent.ctx.fiber.uid === null) return
      if (bot !== undefined && isManagedBot(bot.id)) {
        lifetime.signal.throwIfAborted()
        guardHostFallback(agent)
      } else if (lifetime.signal.aborted) return
      signal?.throwIfAborted()
      if (bot === undefined || !isDesktopBot(bot.id)) {
        if (managedBotIds === undefined || legacyComputer === undefined) return
        const canUseComputer = (): boolean => {
          const preset = ctx.get('agentPresets')?.composedPreset(agent.ctx)
          return preset !== undefined && /^(?:standard|cordis|ptc)$/u.test(preset)
        }
        if (!canUseComputer()) return
        await bind(agent, ComputerTool.inject, (agentCtx) => {
          ComputerTool.apply(agentCtx)
          agentCtx.effect(() => agentCtx.tools.guard(exec => exec.name === 'vps_computer' && !canUseComputer()
            ? 'This Agent preset cannot access the private Computer.'
            : undefined), 'vps-bots: preserve legacy Computer guard')
        })
        return
      }
      const installComputerTool = async (agentCtx: Context): Promise<void> => {
        const workspaceFiles = scope.get('workspaceFiles')
        if (workspaceFiles !== undefined) {
          registerVpsBotFileTools(agentCtx, agent,
            new VpsBotFileHandoffs({ bots: scope.bots, workspaceFiles }, runtimeFor, isDesktopBot, uploadLimits),
            !isManagedBot(bot.id))
          const runtime = runtimeFor(bot.id)
          const { sharedRoot } = runtime
          if (sharedRoot !== undefined) {
            const findFiles = filesFor(scope, isDesktopBot)
            const access = (requestSignal: AbortSignal) => findFiles(bot.sessionId, requestSignal, sharedRoot)
            const setAccess = registerVpsProjectTool(agentCtx, agent, workspaceFiles, access)
            agentCtx.effect(() => {
              projectToolGrants.set(bot.sessionId, setAccess)
              return () => {
                /* v8 ignore else -- Session admission serialization keeps the old Agent registered until its scoped disposers drain. */
                if (projectToolGrants.get(bot.sessionId) === setAccess) projectToolGrants.delete(bot.sessionId)
              }
            }, 'vps-bots: update the Bot project tool when access changes')
            const granted = await runtime.sharedWorkspaceFor(bot.sessionId) !== undefined
            lifetime.signal.throwIfAborted()
            signal?.throwIfAborted()
            await setAccess(granted)
          }
        }
        ComputerTool.applyVpsBotComputer(agentCtx, async (sessionId, requestSignal) => {
          if (sessionId !== bot.sessionId) throw new Error('VPS Computer requires the owning Bot Session.')
          return computerFor(sessionId, bot.id, requestSignal)
        }, hasBrowserSignIn(bot.id) ? async (caller, signal) => {
          if (caller !== agent || !await scope.bots.isDirectOwnerTurn(caller, signal)) {
            throw new Error('Computer sign-in is available in a direct owner Bot chat.')
          }
          const computer = await computerFor(bot.sessionId, bot.id, signal)
          if (browserLogin?.hasPending(bot.sessionId) === true) {
            throw new Error('Resolve the pending Vault sign-in before requesting Computer handoff.')
          }
          return computer.requestSignIn(signal)
        } : undefined, isIsolatedBrowserBot(bot.id) ? (sessionId, url, signal) => {
          if (sessionId !== bot.sessionId) throw new Error('VPS Computer requires the owning Bot Session.')
          return navigateFor(bot.id, sessionId, url, signal)
        } : undefined, browserLogin !== undefined && isIsolatedBrowserBot(bot.id) ? async (caller, signal) => {
          const source = caller === agent ? await scope.bots.privateOwnerTurnSource(caller, signal) : undefined
          if (source === undefined) {
            throw new Error('Saved website login requires a direct owner message or a private time-based routine.')
          }
          const computer = await computerFor(bot.sessionId, bot.id, signal)
          const lease: VpsBrowserLoginLease = (operation, requestSignal) => computer.runWhileBotControls(operation, requestSignal)
          return source === 'schedule'
            ? browserLogin.requestForRoutine(bot.id, bot.sessionId, lease, signal)
            : browserLogin.request(bot.id, bot.sessionId, lease, signal)
        } : undefined, isIsolatedBrowserBot(bot.id) ? async (sessionId, requestSignal) => {
          if (sessionId !== bot.sessionId) throw new Error('VPS Computer requires the owning Bot Session.')
          return desktopFor(sessionId, bot.id, requestSignal)
        } : undefined)
      }
      if (!isManagedBot(bot.id)) {
        await bind(agent, ['terminalController', 'subprocess'], (terminalCtx) => {
          const runtime = runtimeFor(bot.id)
          const subprocess = new VpsBotSubprocess(terminalCtx.isolate('subprocess'), {
            runtime, sessionId: bot.sessionId, host: terminalCtx.subprocess,
          })
          terminalCtx.effect(() => terminalCtx.terminalController.bindWorkspace(agent, {
            cwd: runtime.workspace(bot.sessionId), subprocess,
          }), 'vps-bots: bind owner terminal')
        })
        await bind(agent, ['tools', 'attachments', 'llm', 'systemPrompt'], async (agentCtx) => {
          agentCtx.systemPrompt.section({
            name: 'app:vps-bot-desktop',
            order: agentCtx.systemPrompt.getSectionOrder('WEB_SURFACE'),
            text: () => 'Use vps_computer for visual interaction on your private VPS desktop. '
              + 'Bash and file tools use your existing Session workspace and permissions.',
          })
          await installComputerTool(agentCtx)
          if (journal !== undefined) registerVpsJournalTool(agentCtx, bot.id, bot.sessionId, journal, agent.ctx, lifetime.signal)
        })
        return
      }
      await bind(agent, ['tools', 'attachments', 'llm', 'systemPrompt', 'subprocess', 'sandboxPolicy'], async (agentCtx) => {
        const runtime = runtimeFor(bot.id)
        const workspace = runtime.workspace(bot.sessionId)
        const managedContext = agentCtx.isolate('fs').isolate('subprocess').isolate('shell')
        const subprocess = new VpsBotSubprocess(managedContext, {
          runtime, sessionId: bot.sessionId, host: agentCtx.subprocess,
        })
        const fs = new VpsBotFileSystem(managedContext, runtime, bot.sessionId)
        const shell = new LocalBashExecutor(managedContext, LocalBashExecutor.Config({ cwd: workspace, timeoutMs: 60_000 }))
        const policy = agentCtx.sandboxPolicy
        const execution = createManagedBotExecution({
          // The capability is looked up against the exact agent context used by
          // tool execution. Providers remain isolated in `managedContext`.
          context: agent.ctx,
          workspaceRoot: workspace,
          shell,
          fs,
          subprocess,
          sandboxPolicy: {
            defaultMode: 'workspace-write',
            resolve: (request) => {
              const standing = policy.resolve(request)
              return { ...standing, workspaceRoot: workspace, mode: standing.mode === 'read-only' ? 'read-only' : 'workspace-write' }
            },
          },
          shellEnv: {},
        })
        agentCtx.effect(() => bindManagedBotExecution(agent.ctx, execution), 'vps-bots: bind execution')
        agentCtx.inject(['terminalController'], (terminalCtx) => {
          terminalCtx.effect(() => terminalCtx.terminalController.bindWorkspace(agent, { cwd: workspace, subprocess }),
            'vps-bots: bind owner terminal')
        })
        agentCtx.on('tools/pre-execute', async (call, next) => {
          if (call.name === 'bash' || call.name === 'grep' || call.name === 'glob') {
            if (call.name === 'bash' && execution.sandboxPolicy.resolve({ session: agent.session }).mode === 'read-only') {
              return { kind: 'deny', reason: 'This Bot Session is read-only.' }
            }
            await runtime.ensure(bot.sessionId)
          }
          return next()
        }, { prepend: true })
        agentCtx.effect(() => agentCtx.tools.presentAs('native'), 'vps-bots: native tool dispatch')
        agentCtx.effect(() => agentCtx.tools.guard((call) => {
          if (BOT_TOOLS.has(call.name)) return undefined
          const source = agentCtx.tools.get(call.name, agent)?.source
          if (source?.kind === 'mcp' || source?.kind === 'mcp-resource') return undefined
          return 'This tool is unavailable inside the Bot’s VPS environment.'
        }), 'vps-bots: protect the host from Bot tools')
        agentCtx.systemPrompt.section({
          name: 'app:vps-bot',
          order: agentCtx.systemPrompt.getSectionOrder('WEB_SURFACE'),
          text: () => 'You have your own computer on the VPS with a managed runtime workspace. '
            + 'Use Bash, file tools and vps_computer there; do not use the Chat session cwd. '
            + 'Host service access requires a separate grant. Mac permissions do not apply here.',
        })
        await installComputerTool(agentCtx)
        registerVpsServiceTools(agentCtx, bot.id, services, agent, lifetime.signal)
        if (journal !== undefined) registerVpsJournalTool(agentCtx, bot.id, bot.sessionId, journal, agent.ctx, lifetime.signal)
      })
    }
    const attach = (agent: Agent, signal?: AbortSignal): Promise<void> => {
      const current = attachments.get(agent)
      if (current !== undefined) return current
      const pending = installAgent(agent, signal)
      attachments.set(agent, pending)
      void pending.catch(() => { attachments.delete(agent) })
      return pending
    }
    scope.on('agent/created', async ({ agent, signal }) => { await attach(agent, signal) })
    for (const agent of scope.get('agents')?.list() ?? []) {
      void attach(agent).catch((error: unknown) => {
        void error
        if (!lifetime.signal.aborted) scope.logger.warn('Could not rebind the private VPS Computer to an active Bot.')
      })
    }
  })
}
