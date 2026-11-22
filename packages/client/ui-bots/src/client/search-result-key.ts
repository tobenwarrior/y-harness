/** Keyboard navigation shared by Bot conversation searches. */
import type { KeyboardEvent } from 'react'

/**
 * Move to or open the first result without interrupting input composition.
 * @param event - Key from the search field.
 * @param firstResult - First visible result, when available.
 */
export function searchResultKey(event: KeyboardEvent<HTMLInputElement>, firstResult: HTMLButtonElement | null): void {
  if (event.nativeEvent.isComposing || firstResult === null) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    firstResult.focus()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    firstResult.click()
  }
}
