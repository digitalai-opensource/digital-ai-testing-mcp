/**
 * Failure message → likely cause → first action. Every row is a message seen live on this platform (dates in
 * CLAUDE.md); used by the investigate_test_failures prompt and docs/tools.md. Add a row only for a message you have
 * actually observed — a guessed mapping sends the agent down the wrong path with confidence.
 */
export interface TriageRow {
  /** A distinctive part of the platform / driver message. */
  message: string;
  cause: string;
  action: string;
}

export const FAILURE_TRIAGE: TriageRow[] = [
  {
    message: 'No available device matching the query',
    cause: 'nothing free matches the device query within newSessionWaitTimeout (busy pool, wrong region, a typo in the query)',
    action: 'find_available_device with the same constraints; widen the query or add a region where devices are free.',
  },
  {
    message: 'Activity name … used to start the app doesn\'t exist or cannot be launched',
    cause: 'the app is not installed on that device (a test without the app capability, e.g. appReset keep-data) or the activity is wrong',
    action: 'install_application on the pool, or check mainActivity with get_application_info.',
  },
  {
    message: 'Could not forward request POST /wd/hub/session / The Appium server failed to respond (at session start)',
    cause: 'the driver failed while starting the app and the platform hid its reason — a wrong appWaitActivity or appActivity did this live',
    action: 'check the launch capabilities first (appPackage/appActivity/appWaitActivity, bundleId), then the device.',
  },
  {
    message: 'The application under test with bundle id … is not running, possibly crashed',
    cause: 'the iOS app crashed (or was closed) during the step',
    action: 'watch the report video at that step; get_device_log type crashlog in an inspection session reproduces it.',
  },
  {
    message: 'Cant run Appium Grid with Appium client 8+',
    cause: 'a W3C-only session request sent to an Appium Grid project — not a client version check',
    action: 'use the Grid boilerplate (desiredCapabilities, pinned clients) or move the project to Appium Server.',
  },
  {
    message: 'DeviceOSVersionTooLow',
    cause: 'the pinned Appium version needs a newer iOS (3.8.1 needs iOS 17+)',
    action: 'pin appiumVersion 3.8.0 for older iPhones, or narrow the query to iOS 17+.',
  },
  {
    message: 'invalid session id / session … not found / terminated',
    cause: 'the session ended under the test (idle timeout, device or WebDriverAgent crash)',
    action: 'do not raise waits; check the device (get_device_health_summary) and the report video.',
  },
  {
    message: 'NoSuchElement / An element could not be located — only on some devices, every run',
    cause: 'the device is in an unexpected state (left on another screen or language, a system dialog on top, or offline in the pool)',
    action: 'find_unhealthy_devices / list_devices for that device; pin the language (deviceLanguage) or exclude the device.',
  },
  {
    message: 'Failed to boot emulator',
    cause: 'the emulator/simulator template could not start',
    action: 'pick another model or OS version (list_virtual_device_templates) or a real device — do not retry unchanged.',
  },
  {
    message: 'Device query length restricted to 255',
    cause: 'the device query (with any region clause) is longer than the platform accepts',
    action: 'shorten it — drop redundant clauses or use contains().',
  },
];
