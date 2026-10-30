#!/usr/bin/env node

import { Context } from '@yharness/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@yharness/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@yharness/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
