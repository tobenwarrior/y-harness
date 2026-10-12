/** Production Settings component with synthetic native source history for root's built browser evidence. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { CodingSessionsController } from '../src/client/controller.ts'
import { CodingSessionsSection } from '../src/client/CodingSessionsSection.tsx'
import type { CodingSessionsSectionProps } from '../src/client/CodingSessionsSection.tsx'
import { en } from '../src/client/locales.ts'
import { fixtureApi, mirror } from './fixtures.client.ts'
const dictionary = { ...commonEn, ...en }
const t: CodingSessionsSectionProps['t'] = key => dictionary[key]
/** @returns a source-labelled readable original-native-ID mirror using the actual component and controller. */
export function CodingSessionsFixture(): ReactNode {
  const [controller] = useState(() => {
    const value = new CodingSessionsController(fixtureApi())
    void value.refreshState().then(async () => { await value.discover(mirror.source); await value.select(mirror.id) })
    return value
  })
  useEffect(() => () => { controller.dispose() }, [controller])
  const useSessions: CodingSessionsSectionProps['useSessions'] = selector => useSyncExternalStore(listener => controller.source.subscribe(listener), () => selector(controller.source.getSnapshot()))
  return <CodingSessionsSection {...controller.face()} useSessions={useSessions} t={t} />
}
