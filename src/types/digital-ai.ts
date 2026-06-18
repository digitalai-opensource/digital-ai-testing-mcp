// ─── Generic ────────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  status: 'SUCCESS' | 'ERROR';
  data: T;
  code: string;
  message?: string;
}

// ─── Users ──────────────────────────────────────────────────────────────────

export interface User {
  id: number;
  userName: string;
  firstName: string;
  lastName: string;
  email: string;
  created: number;
  roles: Record<string, string[]>;
  authenticationType: 'BASIC' | 'SSO' | 'TWO_FA';
  tags: string[];
  lastAuthentication: string | null;
  notes?: string;
}

export interface CreateUserParams {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  role: 'Admin' | 'ProjectAdmin' | 'User';
  project?: number;
  password?: string;
  authenticationType?: 'BASIC' | 'SSO' | 'TWO_FA';
}

export interface ProjectAssignment {
  projectId: number;
  role?: 'User' | 'ProjectAdmin';
  allowToReserveDevice?: boolean;
}

export interface MyAccountInfo {
  username: string;
  firstName: string;
  lastName: string;
  role: string;
  project: {
    id: number;
    name: string;
    isAppiumOss?: boolean;
    created: number;
    notes: string | null;
  };
}

// ─── Devices ─────────────────────────────────────────────────────────────────

export interface Device {
  id: string;
  udid: string;
  iosUdid: string;
  deviceName: string;
  notes: string;
  deviceOs: 'Android' | 'iOS';
  osVersion: string;
  model: string;
  modelName?: string;
  manufacturer: string;
  currentUser: string;
  deviceCategory: 'PHONE' | 'TABLET' | 'WATCH' | 'UNKNOWN';
  uptime: string;
  isEmulator: boolean;
  profiles: string;
  agentName: string;
  agentIp: string;
  agentLocation: string;
  region: string;
  currentStatus: string;
  statusTooltip?: string;
  displayStatus: string;
  lastUsedDateTime: string;
  previousStatus?: string;
  statusAgeInMinutes: string;
  statusModifiedAt?: string;
  statusModifiedAtDateTime: string;
  whitelistCleanup?: boolean;
  defaultDeviceLanguage?: string | null;
  defaultDeviceRegion?: string | null;
  iosConfigurationProfiles?: string[];
  screenWidth?: number;
  screenHeight?: number;
  tags: string[];
  project?: string;
  deviceGroups?: Record<string, string>;
  lastActivity?: number;
  phoneNumber1?: string;
  phoneNumber2?: string | null;
  bluetooth?: { adapterName: string; state: string };
}

export interface EditDeviceParams {
  name?: string;
  notes?: string;
  category?: 'PHONE' | 'TABLET' | 'WATCH' | 'UNKNOWN';
}

// NOTE: Device reservation endpoints (under /api/v1/devices/) use a different
// timestamp format: YYYY-MM-DD-hh-mm-ss (e.g. "2024-01-15-13-30-00")
// This is DIFFERENT from the /api/v1/device-reservations API which uses ISO 8601.

export interface DeviceReservationEntry {
  start: string;
  end: string;
  id: number;
  title: string;
}

// ─── Device Reservations (via /api/v1/device-reservations) ──────────────────

export interface DeviceReservation {
  reservationId: number;
  reservationStart: string;
  reservationEnd: string;
  reservationNotes?: string;
  username: string;
  project: string;
  deviceUid: string;
  deviceID: number;
}

export interface ReservationFilters {
  // Server-side filters (working): username, projectId, deviceId, serialNumber
  username?: string;
  projectId?: number;
  deviceId?: number;
  serialNumber?: string;
  // Client-side filters (server silently ignores these):
  project?: string;       // project name — filter client-side
  deviceUid?: string[];   // UDID array — filter client-side
  start?: string;         // ISO 8601 start — filter client-side
  end?: string;           // ISO 8601 end — filter client-side
}

export interface AddReservationParams {
  deviceUid: string[];
  reservationStart: string;
  reservationEnd: string;
  username?: string;
  project?: string;
  notes?: string;
}

// ─── Device Groups ───────────────────────────────────────────────────────────

export interface CreateDeviceGroupParams {
  name: string;
  acceptNewDevices?: boolean;
}

export interface EditDeviceGroupParams {
  name?: string;
  acceptNewDevices?: boolean;
}

// ─── Applications ────────────────────────────────────────────────────────────

export interface Application {
  id: number;
  name: string;
  packageName?: string | null;
  bundleIdentifier?: string | null;
  productId?: string | null;
  applicationName: string;
  uniqueName?: string | null;
  notes?: string | null;
  osType: 'IOS' | 'ANDROID';
  version: string;
  buildVersion: string;
  releaseVersion: string;
  fileType: 'apk' | 'ipa' | 'aab' | 'zip';
  createdAt: number;
  createdAtFormatted: string;
  mainActivity?: string | null;
  isForSimulator: boolean;
  cameraSupport: boolean;
  networkCaptureSupport: boolean;
  nonInstrumented?: boolean;
  hasCustomKeystore?: boolean;
  fixKeychainAccess?: boolean;
  overrideEntitlements?: string | null;
  allowResign?: boolean;
  distributionType?: string;
  instrumentByProfile?: string | null;
  signWithProfile?: string | null;
  installMDM?: boolean;
  installAttributesMDM?: Record<string, unknown> | null;
  autoTrustEnterpriseDeveloper?: boolean;
  projectsInfo?: Array<{ id: number; name: string }>;
  canDelete: boolean;
  plugins?: Array<{ name: string; uuid: string }>;
}

export interface ApplicationFilters {
  osType?: 'ios' | 'android';
  packageName?: string;
  mainActivity?: string;
  bundleIdentifier?: string;
  uniqueName?: string;
  buildVersion?: string;
  releaseVersion?: string;
  cameraSupport?: boolean;
  networkCaptureSupport?: boolean;
  isForSimulator?: boolean;
  hasCustomKeystore?: boolean;
  fileType?: 'apk' | 'ipa' | 'aab' | 'zip';
  autoTrustEnterpriseDeveloper?: boolean;
  installMDM?: boolean;
}

export interface UploadAppParams {
  uniqueName?: string;
  camera?: boolean;
  touchId?: boolean;
  project?: string;
  uuid?: string;
  fixKeychainAccess?: boolean;
  overrideEntitlements?: string;
  allowResign?: boolean;
  signPlugins?: boolean;
  installMDM?: boolean;
  installAttributesMDM?: Record<string, unknown>;
  autoTrustEnterpriseDeveloper?: boolean;
  keystorePassword?: string;
  keyAlias?: string;
  keyPassword?: string;
  networkCaptureSupport?: boolean;
}

export interface AppPlugin {
  name: string;
  uuid: string;
}

// ─── File Repository ─────────────────────────────────────────────────────────

export interface RepositoryFile {
  id: number;
  uniqueName: string;
  description: string | null;
  extension: string;
  size: number;
  uploadedBySystem: boolean;
  // API format: "MM/DD/YYYY HH:mm:ss" — not ISO 8601.
  uploadTime: string;
  lastUpdate: string;
  uploadedUser: string;
  lastUpdatedUser: string;
  projectName: string;
  installInSession?: boolean;
}

export interface RepositoryFileFilters {
  projectId?: string;
  projectName?: string;
  uniqueName?: string;
}

// ─── Browsers (Selenium) ─────────────────────────────────────────────────────

export interface Browser {
  browserName: string;
  browserVersion: string;
  platform: string;
  osName: string;
  agentName: string;
  region: string;
}

export interface ManualTestStep {
  name: string;
  description?: string;
  expectedResult?: string;
  attachment?: string;
}

// ─── Projects ────────────────────────────────────────────────────────────────

export interface Project {
  id: number;
  name: string;
  created?: number;
  notes?: string | null;
  isAppiumOss?: boolean;
}

export interface ProjectUser {
  id: number;
  username: string;
  role: 'User' | 'ProjectAdmin';
  allowToReserveDevice: boolean;
}

export interface AutomationProperty {
  projectId: number;
  dataType: string;
  propertyGroup: string;
  propertyName: string;
  propertyValue: string;
  createdAt: number;
  id: number;
}

// Full project detail from GET /api/v2/projects/{id} — Cloud Admin only.
// Contains 35+ fields not available in the v1 list endpoint.
export interface ProjectAdminDetail {
  id: number;
  name: string;
  notes?: string | null;
  createdAt: number;
  amountOfUsers: number;
  amountOfApplications: number;
  totalSizeOfApplications?: number;
  // Token / API key settings
  tokens: number;
  isTokenMode: boolean;
  // Per-type license limits (-1 = unlimited)
  maxDevelopmentLicense: number;
  maxManualLicense: number;
  maxGridLicenses: number;
  maxEmulatorsLicense: number;
  maxSeleniumSessions: number;
  maxQueuedTests: number;
  maxGridMemory: number;
  // Reservation limits (0 = unlimited, -1 = unlimited)
  maxReservations: number;
  maxReservationsPerUser: number;
  maxReservationTime: number;
  minNotesReservationTime: number;
  // Telephony
  allowSMS: boolean;
  allowCalls: boolean;
  // App management
  daysToKeepApplications: number;
  deleteOldApplications: boolean;
  userCanUploadDeleteApplications: boolean;
  userCanDownloadApplications: boolean;
  // Cleanup flags
  enableCacheCleanup: boolean;
  enableApplicationsCleanup: boolean;
  enableResetLanguageAndRegion: boolean;
  enableIosConfigurationProfileCleanup: boolean;
  enableWifiAndProxyCleanup: boolean;
  enableMediaFoldersCleanup: boolean;
  enableWebhookCleanup: boolean;
  enableClearDeviceLogs: boolean;
  enableIosPasscodeCleanup: boolean;
  enableDeviceCleanup: boolean;
  enableReleaseWithoutCleanup: boolean;
  closeAppsAfterCleanup: boolean;
  // Feature flags
  accessibilityTesting: boolean;
  exposeSessionsToProjectUsers: boolean;
  exposeDebugToProjectUsers: boolean;
  allowProjectAdminsChangeAutomation: boolean;
  enableFileRepository: boolean;
  enableFileRepositoryUserAccessible: boolean;
  defaultAppiumServerVersion?: string | null;
  // Device groups associated with this project
  deviceGroups?: Array<{ id: number; name: string; type?: string }>;
}

// ─── Test Reports ────────────────────────────────────────────────────────────

export interface TestReportAttachment {
  filePath: string;
  type: string;
  size: number;
}

export interface TestReportStep {
  name: string;
  status: string;
  duration?: number;
  subSteps?: TestReportStep[];
}

export interface TestReport {
  uuid: string;
  test_id: number;
  name: string;
  status: 'Passed' | 'Failed' | 'Incomplete';
  status_code: number;
  success: boolean;
  start_time: string;
  create_time: string;
  duration: number | null;
  project_id: number;
  has_attachment: string;
  attachment_count: number;
  attachments_size: number;
  testAttachments?: TestReportAttachment[];
  steps?: TestReportStep[];
}

export interface TestSortField {
  property: string;
  descending: boolean;
}

export interface TestFilterField {
  property: string;
  operator: string;
  value: string | number | boolean;
}

export interface TestListRequest {
  returnTotalCount?: boolean;
  limit?: number;
  page?: number;
  searchValue?: string;
  sort?: TestSortField[];
  filter?: TestFilterField[];
  keys?: string[];
}

export interface TestGroupRequest {
  returnTotalCount?: boolean;
  pivotBy?: Array<'success' | 'status'>;
  groupBy?: string[];   // API field name — NOT "keys" (keys is silently ignored by the server)
  filter?: TestFilterField[];
}

export interface TestListResponse {
  count?: number;
  data: TestReport[];
}

// ─── Test Views ──────────────────────────────────────────────────────────────

export interface TestView {
  id: number;
  name: string;
  byKey: string;
  createdBy: string;
  showInDashboard: boolean;
  groupByKey1?: string;
  groupByKey2?: string;
  keys?: string[];
}

export interface CreateTestViewParams {
  name: string;
  byKey: string;
  groupByKey1?: string;
  groupByKey2?: string;
  keys?: string[];
  showInDashboard?: boolean;
}

export interface UpdateTestViewParams {
  id: number;
  name?: string;
  showInDashboard?: boolean;
}

export interface TestViewSummary {
  passedCount: number;
  failedCount: number;
  incompleteCount: number;
  skippedCount: number;
  _count_: number;
}

export interface TestViewListRequest {
  limit: number;
  page: number;
  sort?: TestSortField[];
  searchValue?: string;
}

export interface TestViewListResponse {
  count: number;
  data: TestView[];
}

// ─── Provisioning Profiles ───────────────────────────────────────────────────

export interface ProvisioningProfile {
  applicationPrefix: string;
  // Format from API: "MM/DD/YYYY HH:mm:ss" — NOT ISO 8601. Parse with parseProvisioningDate().
  expirationDate: string;
  profileUUID: string;
  profileName: string;
  sharedDevices?: boolean;
  notes?: string;
}

// ─── Agents (v2 API — Cloud Admin only) ──────────────────────────────────────

// The v2 agents API returns region as a full object, not a plain string.
export interface AgentRegion {
  id: number;
  name: string;
  master: boolean;
  icon?: string;
}

export interface Agent {
  id: number;
  name: string;
  location: string;
  region: AgentRegion;  // object with {id, name, master, icon} — use region.name for display
  hostOrIp: string;
  port: number;
  secured: boolean;
  externalHostOrIp?: string;
  externalPort?: number;
  osType: string;
  osVersion: string;
  xcodeVersion?: string;
  version: string;
  available: boolean;
  enabled: boolean;
  devicesCount: number;
  statusForDisplay: string;
  simulatorsEnabled?: boolean;
  simulatorStatus?: string;
  emulatorStatus?: string;
  warningMessages?: string[];
  warning?: boolean;
  startupTimestamp?: number;
  cambrionixSupported?: boolean;
  mssbSupported?: boolean;
}

// ─── Regions (v2 API — Cloud Admin only) ─────────────────────────────────────

export interface Region {
  id: number;
  name: string;
  master: boolean;
  icon?: string;
  status: string;
  hostOrIp: string;
  port: number;
  location: string;
  version?: string;
  os?: string;
  details?: string;
  errors?: string[];
  warnings?: string[];
}

export interface RegionComponent {
  id: number;
  status: string;
  name: string;
  host: string;
  port: number;
  error?: string;
  warnings?: string[];
}

export interface RegionTopology {
  nvservers: RegionComponent[];
  seleniumAgents: RegionComponent[];
  signers: RegionComponent[];
  storages: RegionComponent[];
  dhms: RegionComponent[];
  ehms: RegionComponent[];
  reporters: RegionComponent[];
  text2Tests?: RegionComponent[];
  analytics?: RegionComponent[];
  dockerSwarms?: RegionComponent[];
  mdms?: RegionComponent[];
}

// ─── NV Servers (v2 API — Cloud Admin only) ──────────────────────────────────

export interface NvServer {
  id: number;
  name: string;
  hostOrIp: string;
  status: string;
  tunnelingConnected: boolean;
  proxyServerPort?: number;
  tunnelingPort?: number;
  wifissid?: string;
  addressForSeleniumTunneling?: string;
  region: AgentRegion | string;  // API returns AgentRegion object; may be string on some deployments
  version?: string;
  error?: string;
  warning?: string;
  startTime?: number;
}

// ─── Device Groups v2 (Cloud Admin only) ─────────────────────────────────────

export interface DeviceGroupV2 {
  id: number;
  name: string;
  type: string;
  acceptNewDevices: boolean;
  numberOfDevices: number;
}

// ─── Active Sessions (v2 API — Cloud Admin only) ──────────────────────────────

export interface ActiveSession {
  sessionID: string;
  id: number;
  name: string;
  ip: string;         // Contains agent info string (e.g. "US-SelWin, WIN10, chrome 142"), not an IP
  hostname: string;
  username: string;
  usernameAndHostname: string;
  productName: string;
  productVersion: string;
  projectname: string; // Note: lowercase 'n' — matches API response casing
  lastAliveTime: number;
  lastInteractionTime: number;
}

// ─── Reporter Project Storage (reporter API — Cloud Admin only) ────────────────

export interface ReporterProject {
  id: number;
  name: string;
  created: number;
  currentDiskStorageInMB: number;
  diskStorageThresholdInMB: number;
  percentageStorageToPurge: number;
  usagePct: number;
  allowNewKeysFromCode: boolean;
  allowUsersDeleteTests: boolean;
  showInAdminDashboard: boolean;
  testsCount: number | null;
  dataItemsCount: number;
  dataItemAvgSize: number;
  reportSharingEnabled: boolean;
}

// ─── License (v2 API — Cloud Admin only) ─────────────────────────────────────

export interface LicenseInfo {
  dedicatedDevices: number;
  sharedDevices: number;
  virtualDevices: number;
  browsers: number;
}

// ─── Transactions (Performance reporting — reporter API, JWT only) ─────────────
// Transactions are performance-instrumented segments of a test session.
// Developers mark start/end points; the platform records CPU, memory, battery,
// and network metrics for each interval. Linked to a test run via testId.

export interface TransactionSample {
  timestamp: number;  // Unix ms
  value: number;
}

export interface Transaction {
  id: number;
  name: string;               // Transaction name (e.g. "Login", "Checkout")
  appName: string;
  appVersion: string;
  startTime: string;          // ISO 8601
  date: string;               // YYYY-MM-DD
  deviceUid: string;
  deviceName: string;
  deviceModel: string;
  deviceOs: string;           // "Android" or "iOS"
  deviceManufacturer: string;
  deviceVersion: string;      // OS version string
  deviceScreen: string;       // e.g. "1080 x 2190"
  deviceType: string;         // "PHONE", "TABLET"
  networkProfile: string;
  cpuAvg: number | null;      // %
  cpuMax: number | null;      // %
  cpuCoreCount: number | null;
  memAvg: number | null;      // MB
  memMax: number | null;      // MB
  memTotalInBytes: number | null;
  batteryAvg: number | null;  // mW
  batteryMax: number | null;  // mW
  totalUploadedBytes: number;
  totalDownloadedBytes: number;
  duration: number;           // ms
  speedIndex: number | null;
  videoStart: number | null;
  videoEnd: number | null;
  userName: string;
  testId: number | null;
  attachmentId: number | null;
  attachmentPath: string | null;
  projectId: number;
  projectName: string;
  attachmentList: unknown | null;
  // Only on GET /reporter/api/transactions/{id} — not in list results
  cpuSamples?: TransactionSample[];
  memorySamples?: TransactionSample[];
  batterySamples?: TransactionSample[];
  networkDownloadSamples?: TransactionSample[];
  networkUploadSamples?: TransactionSample[];
  attachments?: unknown[];
}

// ─── Performance Comparison (built on Transaction data) ──────────────────────
// Result shapes for compare_performance_transactions / assess_comparison_confounds
// / detect_performance_outliers. The statistical primitives (MetricSummary,
// OutlierResult) live in src/utils/performance-stats.ts; these are the
// domain-level report objects assembled in src/utils/performance-comparison.ts.

// Which dimensions are allowed as the declared "comparison axis" — the thing
// that is SUPPOSED to differ between the two sides. Anything else that varies
// is a confound.
export type ComparisonDimension =
  | 'appVersion'
  | 'deviceModel'
  | 'deviceOs'
  | 'deviceVersion'
  | 'networkProfile'
  | 'deviceName'
  | 'projectName'
  | 'name'        // transaction name
  | 'region'      // derived from deviceName suffix / device record; best-effort
  | 'testId';     // two test scripts purporting to test the same thing

// One metric ("speedIndex", "cpuAvg", …) summarised for both sides plus the delta.
export interface MetricComparison {
  metric: string;
  unit: string;
  sideA: import('../utils/performance-stats.js').MetricSummary;
  sideB: import('../utils/performance-stats.js').MetricSummary;
  // Delta is computed on the headline aggregate (trimmedMean, falling back to
  // median then mean) of B minus A. Positive = B is higher than A.
  deltaTrimmedMean: number | null;
  deltaMedian: number | null;
  deltaMean: number | null;
  percentChangeTrimmedMean: number | null; // (B-A)/A * 100 on trimmed mean
}

export interface PerformanceSide {
  label: string;
  transactionIds: number[];
  n: number;
  excludedIds: number[];          // dropped as outliers / missing the metric
}

export interface PerformanceComparison {
  sideA: PerformanceSide;
  sideB: PerformanceSide;
  metrics: MetricComparison[];
  outlierExclusionApplied: boolean;
  trimFraction: number;
  notes: string[];
}

export type ConfoundSeverity = 'high' | 'medium' | 'low' | 'info';

export interface ConfoundFlag {
  dimension: ComparisonDimension | string;
  severity: ConfoundSeverity;
  kind: 'cross-side' | 'within-side' | 'telemetry' | 'imbalance';
  message: string;
  sideAValues?: string[];
  sideBValues?: string[];
}

export interface ConfoundAssessment {
  comparisonAxis: (ComparisonDimension | string)[];
  validity: 'clean' | 'caveated' | 'confounded';
  flags: ConfoundFlag[];
  summary: string;
}

// ─── Inspection Sessions (WebDriver-based native inspection) ─────────────────

export interface InspectionSession {
  handle: string;           // Short user-facing identifier
  gridSessionId: string;    // Full CLOUD-SID:... Grid session ID
  reportTestId: number;     // Reporter test_id — 0 if not captured
  reportUrl: string;        // HTML report link (from caps)
  cloudViewLink: string | null; // Mobile Studio URL (from caps)
  deviceUDID: string;       // Device serial number
  deviceName: string;       // e.g. "Google Pixel 7 sgdemo-0157"
  deviceModel: string;      // e.g. "Pixel 7"
  deviceOs: string;         // "Android"
  deviceVersion: string;    // e.g. "16.0"
  appPackage: string;       // Active app package
  startedAt: number;        // Unix ms timestamp
  lastUsedAt: number;       // Unix ms of the most recent command — idle-timeout awareness
  lastIdleMs?: number;      // Idle gap measured at the start of the current command
  // true when session was started with Cloud Admin credentials — enables automatic report cleanup
  canDeleteReport: boolean;
  // Protocol of the allocating agent: JWP (Appium 1.x) uses touch/perform and
  // /appium/device/* routes; W3C (Appium 2/3) uses /actions and mobile: execute commands.
  sessionFormat: 'jwp' | 'w3c';
  // Target platform — drives element attribute names, launch mechanism, and
  // which keys/controls are available.
  platform: 'android' | 'ios';
  // Project the session was created under — report deletes must scope to this
  // project's reporter instance (test_ids are only unique per instance).
  projectName?: string;
}
