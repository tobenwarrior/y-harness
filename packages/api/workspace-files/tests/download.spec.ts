import { expect, it } from 'vitest'
import { fileDownloadResponse } from '../src/download.ts'

it('returns file bytes with safe attachment headers and the known length', async () => {
  const response = fileDownloadResponse('hello', "report' (1)\n.txt", 5)

  expect(await response.text()).toBe('hello')
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="download"; filename*=UTF-8\'\'report%27%20%281%29_.txt')
  expect(response.headers.get('content-length')).toBe('5')
  expect(response.headers.get('content-type')).toBe('application/octet-stream')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
})

it('replaces invalid Unicode and omits the length when it is unknown', () => {
  const response = fileDownloadResponse('', 'bad\uD800.txt')

  expect(response.headers.get('content-disposition')).toBe('attachment; filename="download"; filename*=UTF-8\'\'bad%EF%BF%BD.txt')
  expect(response.headers.has('content-length')).toBe(false)
})
