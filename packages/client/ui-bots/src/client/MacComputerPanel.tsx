/** Mac permission setup and user-approved sharing for a single Bot. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, StateDot } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { randomUUID } from '@yharness/util-crypto'
import { ComputerPanel } from './ComputerPanel.tsx'
import { createMacComputerClient, type MacComputerOperation, type MacComputerPermission, type MacComputerSetup } from './computer-client.ts'
import css from './ComputerPanel.module.css'

interface MacComputerPanelProps extends PropsLocale<'bots'> {
  readonly sessionId: string
  readonly close: () => void
}

/** Show the native permission checklist or the live display for the selected Bot. */
export function MacComputerPanel({ sessionId, close, t }: MacComputerPanelProps): ReactNode {
  const [viewerId] = useState(randomUUID)
  const client = useMemo(() => createMacComputerClient(sessionId, viewerId), [sessionId, viewerId])
  const [setup, setSetup] = useState<MacComputerSetup>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const local = useMemo(() => ({
    checkSharing: () => { void client.setup('setup').then(setSetup, () => { setFailed(true) }) },
  }), [client])

  useEffect(() => {
    const controller = new AbortController()
    const refresh = (): void => {
      void client.setup('setup', undefined, controller.signal).then((value) => {
        if (!controller.signal.aborted) {
          setSetup(value)
          setFailed(false)
        }
      }, () => {
        if (!controller.signal.aborted) setFailed(true)
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      controller.abort()
      void client.setup('stop').catch((_error: unknown) => { /* The native lease expires when viewing stops. */ })
    }
  }, [client])

  const action = async (operation: MacComputerOperation, permission?: MacComputerPermission): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      setSetup(await client.setup(operation, permission))
    } catch (error: unknown) {
      void error
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (setup?.shared === true) return <ComputerPanel computer={client.computer} close={close} local={local} t={t} />

  return (
    <section className={css.root} aria-label={t('computerTitle')} data-computer-panel>
      <header className={css.toolbar}>
        <div className={css.status}>
          <StateDot state={setup === undefined && !failed ? 'ongoing' : 'idle'} size={8} />
          <span>{t('macComputerTitle')}</span>
        </div>
        <Button variant="ghost" size="sm" icon={<IconCloseOutlineRegular size={14} />}
          aria-label={t('computerClose')} onClick={close} />
      </header>
      <div className={css.setup}>
        <div>
          <h3>{t('macComputerSetupTitle')}</h3>
          <p>{t('macComputerSetupDescription')}</p>
        </div>
        <div className={css.permissionList}>
          {([
            ['screenRecording', 'macComputerScreen', 'macComputerScreenDescription'],
            ['accessibility', setup?.deviceControlLabel === true ? 'macComputerDeviceControl' : 'macComputerAccess', 'macComputerAccessDescription'],
          ] as const).map(([permission, label, detail]) => (
            <div className={css.permission} key={permission}>
              <div><strong>{t(label)}</strong><p>{t(detail)}</p></div>
              {setup?.[permission] === true
                ? <span className={css.granted}><StateDot state="done" size={6} />{t('macComputerGranted')}</span>
                : <Button variant="outline" size="sm" disabled={busy} aria-label={t(label) + ' · ' + t('macComputerSettings')}
                  onClick={() => { void action('settings', permission) }}>{t('macComputerSettings')}</Button>}
            </div>
          ))}
        </div>
        {failed && <p className={css.notice} role="alert">{t('macComputerSetupError')}</p>}
        <p className={css.restart}>{t('macComputerRestart')}</p>
        <div className={css.setupActions}>
          <Button variant="ghost" size="sm" disabled={busy}
            onClick={() => { void action('setup') }}>{t('macComputerCheck')}</Button>
          <Button variant="primary" size="sm" disabled={busy || setup?.screenRecording !== true || !setup.accessibility}
            onClick={() => { void action('start') }}>{t('macComputerStart')}</Button>
        </div>
      </div>
    </section>
  )
}
