/** Browser-only synthetic Decision footer for root-owned visual verification. */
import { useState, type ReactNode } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { DecisionSettings, type DecisionSettingsProps } from '../src/client/DecisionSettings.tsx'
import type { DecisionState } from '../src/client/decision-controller.ts'
import { en } from '../src/client/locales.ts'
const dictionary = { ...commonEn, ...en }
const t: DecisionSettingsProps['t'] = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])
const unused = (): never => { throw new Error('DecisionSettings does not consume global slot hooks') }
const standard: GlobalStandardProps = {
  usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
}

/** Render synthetic native refusal and API preview controls; no provider or Host is contacted. */
export function DecisionFixture(): ReactNode {
  const [source] = useState(() => createSnapshotStore<DecisionState>({ phase: 'ready', status: { configuration: { enabled: false, revision: 0 }, models: [
    { provider: 'codex-backend', model: '', name: 'Codex', available: false, reason: 'native-tools' },
    { provider: 'fixture-api', model: 'small', name: 'Fixture response-only API', available: true, reason: 'response-only' },
  ], maxInputBytes: 16000, maxInputTokens: 16000, maxOutputTokens: 512, timeoutMs: 10000, maxCalls: 1 }, projects: [{ id: 'fixture-project', title: 'Fixture project', path: '/fixture/project' }], controls: null, controlsKey: '', capabilityEpoch: 0, busy: false, error: false, preview: null, notice: null }))
  const noop = (): void => { }
  return <DecisionSettings {...standard} t={t} useDecision={bindSnapshotSelector(source)}
    ensureDecision={noop} refreshDecision={noop} dismissDecisionNotice={noop}
    loadDecisionControls={(route) => {
      source.set({ ...source.getSnapshot(), controls: {}, controlsKey: JSON.stringify([route.provider, route.model]) })
    }}
    saveDecision={(enabled, route) => {
      const state = source.getSnapshot()
      source.set({ ...state, status: { ...state.status!, configuration: {
        revision: state.status!.configuration.revision + 1, enabled, ...(route === undefined ? {} : { route }),
      } } })
    }}
    previewDecision={() => {
      source.set({ ...source.getSnapshot(), preview: [
        { id: 'release', name: 'Fixture release checks' }, { id: 'review', name: 'Fixture patch review' },
      ] })
    }} />
}
