/** Registration-owned library viewing state. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SkillLibraryId, SkillLearningProposalId } from '@deepseek-ai/dsh-skill-library/types'

/** Complete scope and availability filters. */
export interface LibraryNavigation {
  view: 'library' | 'graph' | 'review'
  query: string
  project: string
  status: 'all' | 'active' | 'disabled' | 'archived'
  selectedId: SkillLibraryId | null
  selectedReviewId: SkillLearningProposalId | null
}

type NavigationActions = {
  setView: (draft: LibraryNavigation, view: LibraryNavigation['view']) => void
  setQuery: (draft: LibraryNavigation, query: string) => void
  setProject: (draft: LibraryNavigation, project: string) => void
  setStatus: (draft: LibraryNavigation, status: LibraryNavigation['status']) => void
  select: (draft: LibraryNavigation, id: SkillLibraryId | null) => void
  selectReview: (draft: LibraryNavigation, id: SkillLearningProposalId | null) => void
}

/**
 * Create remount-surviving selection and filters without duplicating inventory data.
 * @returns the main panel's viewing-state store.
 */
export function createNavigationStore(): EngineStoreHandle<LibraryNavigation, NavigationActions> {
  return defineStore({
    init: (): LibraryNavigation => ({ view: 'library', query: '', project: 'all', status: 'all', selectedId: null, selectedReviewId: null }),
    actions: {
      setView: (draft, view: LibraryNavigation['view']) => { draft.view = view },
      setQuery: (draft, query: string) => { draft.query = query },
      setProject: (draft, project: string) => { draft.project = project },
      setStatus: (draft, status: LibraryNavigation['status']) => { draft.status = status },
      select: (draft, id: SkillLibraryId | null) => { draft.selectedId = id },
      selectReview: (draft, id: SkillLearningProposalId | null) => { draft.selectedReviewId = id },
    },
  })
}
