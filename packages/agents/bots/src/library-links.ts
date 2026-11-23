/** Owner Library links projected from settled Bot replies. */

import type { Nodes, Link, LinkReference } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

const MAX_REPLY_LENGTH = 64 * 1024
const MAX_URL_LENGTH = 2_048
const MAX_LABEL_LENGTH = 160
const MAX_LINKS_PER_REPLY = 32

interface LibraryLink {
  readonly label: string
  readonly url: string
}

function* walk(root: Nodes): Generator<Nodes> {
  const pending: Nodes[] = []
  let node: Nodes | undefined = root
  while (node !== undefined) {
    yield node
    if ('children' in node) pending.push(...node.children.toReversed())
    node = pending.pop()
  }
}

function labelOf(link: Link | LinkReference, url: URL): string {
  const parts: string[] = []
  for (const node of walk(link)) {
    if (node.type === 'text' || node.type === 'inlineCode') parts.push(node.value)
  }
  const text = parts.join('').replace(/\s+/g, ' ').trim()
  const label = text === '' || /^https?:\/\//iu.test(text) ? url.hostname : text
  return label.length <= MAX_LABEL_LENGTH ? label : `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`
}

/**
 * List unique web destinations a Bot included in one settled Markdown reply.
 * @param markdown - Plain text blocks from the reply, in order.
 * @returns Safe absolute HTTP(S) destinations with plain, bounded labels.
 */
export function readLibraryLinks(markdown: string): readonly LibraryLink[] {
  if (markdown.length > MAX_REPLY_LENGTH || !/https?:\/\/|www\./iu.test(markdown)) return []
  const definitions = new Map<string, string>()
  const candidates: (Link | LinkReference)[] = []
  for (const node of walk(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }))) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
    if (node.type === 'link' || node.type === 'linkReference') candidates.push(node)
  }
  const links = new Map<string, LibraryLink>()
  for (const candidate of candidates) {
    const destination = candidate.type === 'link' ? candidate.url : definitions.get(candidate.identifier)
    if (destination === undefined || destination.length > MAX_URL_LENGTH || !/^https?:\/\//iu.test(destination)
      || !URL.canParse(destination)) continue
    const url = new URL(destination)
    if (url.href.length > MAX_URL_LENGTH || url.username !== '' || url.password !== '' || links.has(url.href)) continue
    links.set(url.href, { label: labelOf(candidate, url), url: url.href })
    if (links.size >= MAX_LINKS_PER_REPLY) break
  }
  return [...links.values()]
}
