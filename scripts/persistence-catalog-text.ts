/** Authored language pairs for generated persistence reference prose. */

/** Language of a generated persistence reference. */
export type PersistenceCatalogLocale = 'en' | 'zh'

const english = {
  title: 'Session Persistence Event Catalog',
  intro: 'Every repository-declared durable Session event appears here with its source declaration and resolved types. The catalog covers the logical and physical headers, event envelopes, and every plugin declaration merge. See [Session](subsystems/session.md) for replay and [persistence](subsystems/persistence.md) for storage.',
  generation: 'Run `pnpm run gen-persistence-catalog` to regenerate both catalog languages, their pairing record, the known-event module, and the machine schema inventory. `pnpm run verify-persistence-catalog` checks all generated files. Declaration fences preserve source JSDoc and type references; resolved definitions expose their transitive structure.',
  envelopeIntro: 'The envelope carries `type`, `seq`, `time`, `data`, optional `ignorable`, and conditional `surfaceOp` / `sourceEventSeqs`. A **surface** event produces model history; a **log-only** event does not. The inventory covers this repository; external plugin types require their own declarations and are outside this catalog.',
  envelope: 'Event envelope', events: 'Events', sources: 'Sources: ', source: 'Source: ', types: 'Types: ',
  fingerprints: 'Persistence type fingerprints',
  fingerprintsIntro: 'The [machine inventory](persistence-schema.json) contains every reachable normalized type and its SHA-256 digest. Root digests include referenced types. Comments, source locations, alias names, erased brands, readonly markers, and harmless field, union, or intersection reordering do not affect these fingerprints. Tuple order, property names, value types, and optionality do. Catalog text and source locations can still produce a diff when digests stay unchanged.',
  historyIntro: 'The [format references](persistence-changes/historical-formats/README.md) cover every historical Session format. The [change records](persistence-changes/README.md) acknowledge exact transitions using snapshots kept in this tree. Follow the [review workflow](cookbook/reviewing-persistence-type-changes.md) to classify a change and record it. These checks cover declared type structure; opaque payload contents and behavior without type changes are outside their scope.',
  rootColumns: '| Root | Kind | SHA-256 | Resolved type |',
  definitions: 'Resolved persistence types',
  definitionsIntro: 'Each definition appears once. References preserve sharing and recursion; the digest beside a definition includes its complete reachable structure. Source names and locations identify its declarations but are excluded from its digest.',
  propertyColumns: '| Property | Presence | Type |', positionColumns: '| Position | Presence | Type |',
  optional: 'optional', required: 'required', rest: 'rest', index: 'index signature',
  emptyObject: 'Object with no declared properties.', arrayPrefix: 'Array of ', arraySuffix: '.',
  oneOf: 'One of:', opaque: ' (opaque)', opaqueExplanation: ": the declaration does not expose the stored value's internal fields.",
  sourceCompatibility: 'Source compatibility: ', attributionAdditions: 'Attribution-only additions: ',
  sourceColumns: '| kind | Form property | Other required fields | Full definition |',
  notDeclared: 'not declared', none: 'none',
}

const chinese: Record<keyof typeof english, string> = {
  title: '\u4f1a\u8bdd\u6301\u4e45\u5316\u4e8b\u4ef6\u76ee\u5f55',
  intro: '\u672c\u76ee\u5f55\u5217\u51fa\u4ed3\u5e93\u58f0\u660e\u7684\u6bcf\u4e2a\u6301\u4e45\u5316 Session \u4e8b\u4ef6\u53ca\u5176\u6e90\u7801\u58f0\u660e\u548c\u89e3\u6790\u7c7b\u578b，\u8986\u76d6\u903b\u8f91\u4e0e\u7269\u7406 header、\u4e8b\u4ef6\u4fe1\u5c01\u4ee5\u53ca\u5404\u63d2\u4ef6\u7684\u58f0\u660e\u5408\u5e76。\u56de\u653e\u89c4\u5219\u53c2\u89c1 [Session](subsystems/session.zh.md)，\u5b58\u50a8\u89c4\u5219\u53c2\u89c1[\u6301\u4e45\u5316](subsystems/persistence.zh.md)。',
  generation: '\u8fd0\u884c `pnpm run gen-persistence-catalog` \u53ef\u91cd\u65b0\u751f\u6210\u76ee\u5f55\u7684\u4e24\u79cd\u8bed\u8a00、\u914d\u5bf9\u8bb0\u5f55、\u5df2\u77e5\u4e8b\u4ef6\u6a21\u5757\u548c\u673a\u5668 schema \u76ee\u5f55。`pnpm run verify-persistence-catalog` \u68c0\u67e5\u6240\u6709\u751f\u6210\u6587\u4ef6。\u58f0\u660e\u56f4\u680f\u4fdd\u7559\u6e90\u7801 JSDoc \u548c\u7c7b\u578b\u5f15\u7528；\u89e3\u6790\u540e\u7684\u5b9a\u4e49\u5c55\u5f00\u5176\u4f20\u9012\u5f15\u7528\u7ed3\u6784。',
  envelopeIntro: '\u4fe1\u5c01\u5305\u542b `type`、`seq`、`time`、`data`、\u53ef\u9009\u7684 `ignorable` \u4ee5\u53ca\u6761\u4ef6\u5b57\u6bb5 `surfaceOp` / `sourceEventSeqs`。**surface** \u4e8b\u4ef6\u4ea7\u751f\u6a21\u578b\u5386\u53f2，**log-only** \u4e8b\u4ef6\u4e0d\u4ea7\u751f\u6a21\u578b\u5386\u53f2。\u76ee\u5f55\u8986\u76d6\u672c\u4ed3\u5e93；\u5916\u90e8\u63d2\u4ef6\u7c7b\u578b\u9700\u8981\u72ec\u7acb\u58f0\u660e，\u4e0d\u5c5e\u4e8e\u672c\u76ee\u5f55。',
  envelope: '\u4e8b\u4ef6\u4fe1\u5c01', events: '\u4e8b\u4ef6', sources: '\u6765\u6e90：', source: '\u6765\u6e90：', types: '\u7c7b\u578b：',
  fingerprints: '\u6301\u4e45\u5316\u7c7b\u578b\u6307\u7eb9',
  fingerprintsIntro: '[\u673a\u5668\u53ef\u8bfb\u76ee\u5f55](persistence-schema.json)\u5305\u542b\u6240\u6709\u53ef\u8fbe\u7684\u89c4\u8303\u5316\u7c7b\u578b\u53ca\u5176 SHA-256 \u6458\u8981。\u6839\u7c7b\u578b\u7684\u6458\u8981\u6db5\u76d6\u5f15\u7528\u7c7b\u578b。\u6ce8\u91ca、\u6e90\u7801\u4f4d\u7f6e、\u522b\u540d、\u64e6\u9664\u7684\u54c1\u724c\u6807\u8bb0、readonly \u6807\u8bb0\u4ee5\u53ca\u65e0\u8bed\u4e49\u53d8\u5316\u7684\u5b57\u6bb5、\u8054\u5408\u7c7b\u578b\u6216\u4ea4\u53c9\u7c7b\u578b\u91cd\u6392\u4e0d\u5f71\u54cd\u6458\u8981；\u5143\u7ec4\u987a\u5e8f、\u5c5e\u6027\u540d\u79f0、\u503c\u7c7b\u578b\u548c\u53ef\u9009\u6027\u4f1a\u5f71\u54cd\u6458\u8981。\u6458\u8981\u4e0d\u53d8\u65f6，\u76ee\u5f55\u6587\u672c\u548c\u6e90\u7801\u4f4d\u7f6e\u4ecd\u53ef\u80fd\u4ea7\u751f diff。',
  historyIntro: '[\u683c\u5f0f\u53c2\u8003](persistence-changes/historical-formats/README.zh.md)\u8986\u76d6\u6bcf\u4e2a\u5386\u53f2 Session \u683c\u5f0f。[\u53d8\u66f4\u8bb0\u5f55](persistence-changes/README.zh.md)\u901a\u8fc7\u4fdd\u5b58\u5728\u672c\u6e90\u7801\u6811\u4e2d\u7684\u5feb\u7167\u786e\u8ba4\u7cbe\u786e\u7684\u7c7b\u578b\u8f6c\u6362。\u6309\u7167[\u8bc4\u5ba1\u6d41\u7a0b](cookbook/reviewing-persistence-type-changes.zh.md)\u5206\u7c7b\u5e76\u8bb0\u5f55\u53d8\u66f4。\u8fd9\u4e9b\u68c0\u67e5\u8986\u76d6\u5df2\u58f0\u660e\u7684\u7c7b\u578b\u7ed3\u6784；\u4e0d\u900f\u660e\u8f7d\u8377\u7684\u5185\u90e8\u5185\u5bb9\u548c\u672a\u6539\u53d8\u7c7b\u578b\u7684\u884c\u4e3a\u53d8\u66f4\u4e0d\u5728\u68c0\u67e5\u8303\u56f4\u5185。',
  rootColumns: '| \u6839\u7c7b\u578b | \u7c7b\u522b | SHA-256 | \u5df2\u89e3\u6790\u7c7b\u578b |',
  definitions: '\u5df2\u89e3\u6790\u7684\u6301\u4e45\u5316\u7c7b\u578b',
  definitionsIntro: '\u6bcf\u4e2a\u7c7b\u578b\u5b9a\u4e49\u4ec5\u5217\u51fa\u4e00\u6b21。\u5f15\u7528\u4fdd\u7559\u5171\u4eab\u548c\u9012\u5f52\u5173\u7cfb；\u5b9a\u4e49\u65c1\u7684\u6458\u8981\u6db5\u76d6\u5176\u5b8c\u6574\u53ef\u8fbe\u7ed3\u6784。\u6e90\u7801\u540d\u79f0\u548c\u4f4d\u7f6e\u6807\u8bc6\u58f0\u660e\u6765\u6e90，\u4f46\u4e0d\u53c2\u4e0e\u6458\u8981\u8ba1\u7b97。',
  propertyColumns: '| \u5c5e\u6027 | \u5b58\u5728\u6027 | \u7c7b\u578b |', positionColumns: '| \u4f4d\u7f6e | \u5b58\u5728\u6027 | \u7c7b\u578b |',
  optional: '\u53ef\u9009', required: '\u5fc5\u9700', rest: '\u5269\u4f59\u9879', index: '\u7d22\u5f15\u7b7e\u540d',
  emptyObject: '\u65e0\u5df2\u58f0\u660e\u5c5e\u6027\u7684\u5bf9\u8c61。', arrayPrefix: '', arraySuffix: ' \u7684\u6570\u7ec4。',
  oneOf: '\u4ee5\u4e0b\u7c7b\u578b\u4e4b\u4e00：', opaque: '（\u4e0d\u900f\u660e）', opaqueExplanation: '：\u6b64\u58f0\u660e\u672a\u66b4\u9732\u5b58\u50a8\u503c\u7684\u5185\u90e8\u5b57\u6bb5。',
  sourceCompatibility: '\u6d88\u606f\u6e90\u517c\u5bb9\u7b56\u7565：', attributionAdditions: '\u4ec5\u8868\u793a\u5f52\u5c5e\u7684\u65b0\u589e kind：',
  sourceColumns: '| kind | form \u5c5e\u6027 | \u5176\u4ed6\u5fc5\u9700\u5b57\u6bb5 | \u5b8c\u6574\u5b9a\u4e49 |',
  notDeclared: '\u672a\u58f0\u660e', none: '\u65e0',
}

/** Complete translated prose; adding an English key requires its Chinese counterpart. */
export const persistenceCatalogText = { en: english, zh: chinese }
