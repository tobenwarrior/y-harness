// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { BotGroupSentAttachments } from '../src/client/BotGroupAttachments.tsx'

afterEach(cleanup)

it('offers a message-scoped download for an authorized attachment', () => {
  render(<BotGroupSentAttachments
    attachments={[{ attachmentId: 'opaque', name: 'notes.txt', bytes: 5 }]}
    fallbackName="File"
    downloadLabel={name => `Download ${name}`}
    downloadUrl={id => `/download?attachmentId=${id}`}
  />)
  expect(screen.getByRole('link', { name: 'Download notes.txt' }).getAttribute('href')).toBe('/download?attachmentId=opaque')
})
