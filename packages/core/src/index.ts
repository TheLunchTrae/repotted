export {
  checkActionPatterns,
  describeActionCheck,
  describeFoundAction,
  findActions,
} from './profiles/action-patterns.js';
export { createGitHub, GitHubError, parseRepo } from './github/client.js';
export type { GitHub } from './github/client.js';
export { findGitHubApp, gitHubAppSlug } from './github/apps.js';
export type { FoundGitHubApp } from './github/apps.js';
export {
  applyPlan,
  ApplyError,
  captureProfile,
  createPlan,
  describeFailure,
  describeSkipped,
  describeWarning,
  failureReason,
  formatPlan,
  OwnerMismatchError,
  parsePlan,
  skippedDrafts,
  StalePlanError,
} from './plan/plan.js';
export type { Plan } from './plan/plan.js';
export {
  changeOwnerType,
  declaredExtends,
  editProfile,
  entryValueProblems,
  listProfiles,
  parseProfile,
  previewProfile,
  previewProfileChanges,
  ProfileError,
  resolveProfile,
  settingPath,
  settingValueProblems,
  stringifyProfile,
  withExtends,
} from './profiles/profile.js';
export { readProfileForEditing } from './profiles/editing.js';
export { withoutUnknownProfileFields } from './profiles/profile-fields.js';
export type { ConfigurationProblem, EditableProfile } from './profiles/editing.js';
export { ownerHas, ownerTypes, partOwnerTypeCannotHold, settingRules } from './profiles/owner.js';
export type { OwnerNeed, OwnerType } from './profiles/owner.js';
export type { EntryEdit, ProfileEdit, ValueProblem } from './profiles/profile.js';
export { lockChanges, permissionsInProse } from './github/permissions.js';
export type { AppAccess } from './github/permissions.js';
export { permissionsMissingForProfilePart } from './plan/part-permissions.js';
export { profileFileJsonSchema } from './profiles/schema.js';
export { currentUser, listRepositories, readAccess, readInstallationSettingsUrl } from './github/repositories.js';
export type { InstallationMissingPermissions } from './github/repositories.js';
export { listBranches, readBranchChanges } from './profiles/branch-changes.js';
export type { BranchChanges, BranchProfileChange } from './profiles/branch-changes.js';
export { configCommitMessage } from './profiles/commit-messages.js';
export type { ConfigChange } from './profiles/commit-messages.js';
export { syncFolder } from './profiles/sync.js';
export {
  createStagedApply,
  discardStagedApply,
  editStagedApply,
  planStagedApply,
  previewStagedApply,
  resolveStagedApply,
  saveStagedEdits,
} from './staging/staged.js';
export type { StagedApply, StagedEdit, StagedPlan } from './staging/staged.js';
export {
  addToBatch,
  applyBatch,
  batchMemberFile,
  chosenMembers,
  createBatch,
  discardBatch,
  discardBatchMember,
  editEverywhere,
  isBatch,
  isBatchPlan,
  isUnfinished,
  leaveOut,
  parseBatchPlan,
  planBatch,
  readBatch,
} from './staging/batch.js';
export type { Batch, BatchPlan, MemberResult } from './staging/batch.js';

export { settingCondition } from './profiles/setting-dependencies.js';
export type { SettingCondition } from './profiles/setting-dependencies.js';
