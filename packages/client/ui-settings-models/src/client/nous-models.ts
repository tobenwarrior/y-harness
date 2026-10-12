/**
 * Presentation rules for the connected Nous account catalog: how an advertised
 * model name splits into a vendor group and a label, and which few models an
 * account publishes the moment it connects. The account's own order is the only
 * ranking it discloses, so every rule here preserves it.
 */

import type { NousModelView } from '@deepseek-ai/dsh-api-remotes/client'

/** Separator the Portal uses between a vendor name and the model it offers. */
const VENDOR_SEPARATOR = ': '

/**
 * Vendor group of one advertised name.
 * @param name - advertised model name, such as `OpenAI: GPT-6.1 Sol`.
 * @returns the vendor, or an empty string when the name carries none.
 */
export function vendorOf(name: string): string {
  const separator = name.indexOf(VENDOR_SEPARATOR)
  return separator <= 0 ? '' : name.slice(0, separator)
}

/**
 * The model's own label, without the vendor its group header already names.
 * @param name - advertised model name.
 * @returns the label shown beside the checkbox.
 */
export function modelLabel(name: string): string {
  const vendor = vendorOf(name)
  return vendor === '' ? name : name.slice(vendor.length + VENDOR_SEPARATOR.length)
}

/** One vendor's advertised models, in the order the account returned them. */
export interface ModelGroup {
  /** Vendor name, or an empty string for names that carry none. */
  vendor: string
  models: NousModelView[]
}

/**
 * Group a catalog by vendor without reordering anything.
 * @param models - the account's advertised models.
 * @returns the groups in first-appearance order.
 */
export function groupModels(models: readonly NousModelView[]): ModelGroup[] {
  const groups = new Map<string, NousModelView[]>()
  for (const model of models) {
    const vendor = vendorOf(model.name)
    const bucket = groups.get(vendor)
    if (bucket === undefined) groups.set(vendor, [model])
    else bucket.push(model)
  }
  return [...groups].map(([vendor, members]) => ({ vendor, models: members }))
}

/**
 * The small default an account publishes when it connects: its leading
 * advertised models, minus batch variants, so a fresh connection is usable
 * without putting the whole catalog in the composer.
 * @param models - the account's advertised models.
 * @param limit - how many to publish at most.
 * @returns the chosen model ids, in catalog order.
 */
export function starterModels(models: readonly NousModelView[], limit = 5): string[] {
  return models
    .filter(model => !/\(batch\)/i.test(model.name))
    .slice(0, limit)
    .map(model => model.id)
}

/**
 * Fill named count placeholders in one localized template.
 * @param template - copy such as `{enabled} of {total} models enabled`.
 * @param values - the counts each placeholder names.
 * @returns the copy with every named placeholder replaced.
 */
export function countCopy(template: string, values: Readonly<Record<string, number>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder)
}
