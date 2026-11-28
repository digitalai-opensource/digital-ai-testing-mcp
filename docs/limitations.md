# Known Limitations

Read this when a tool refuses a request, gives a result you did not expect, or does not seem to offer something. Each
entry says what the limit is, where it comes from (the Digital.ai platform, the device, or this server), and what to
do instead. Many limits depend on your role, which the server reads from the platform, not from the format of your
access key: **Cloud Admin**, **Project Admin** or **Project User** (see [Access Keys](../README.md#access-keys)).

The numbers are stable: other pages link to them, so new entries are added at the end and the list below groups them
by area.

## Find a limitation by area

**Devices and the device farm**
- [3. Shared devices](#3-shared-devices-not-supported-by-device-apis)
- [5. Regions are read-only](#5-region-management)
- [7. Reboot and USB reset are Cloud Admin only](#7-device-reboot-and-cleanup-limitations-for-non-admin-users)
- [9. Default and Cleanup groups cannot be deleted](#9-default-and-cleanup-device-groups-cannot-be-deleted)
- [11. Reservation timestamp formats](#11-device-reservation-timestamp-formats)
- [26. No fold/unfold control](#26-no-foldunfold-control-for-foldable-devices)
- [30. Emulator and simulator templates](#30-emulator-and-simulator-templates-have-no-region-data)
- [33. Device queries: 255 characters](#33-device-queries-are-limited-to-255-characters)

**Exploring apps and browsers live (inspection sessions)**
- [2. Debug web control mode](#2-remote-debug-session-initiation)
- [12. Screenshots need a session](#12-no-session-free-screenshot-rest-api)
- [13. `get_remote_debug_command` and project roles](#13-get_remote_debug_command-requires-cloud-admin-for-reliable-serial-resolution)
- [14. UIAutomator dump on newer Samsung devices](#14-android-15-samsung-devices-uiautomator-dump-silently-fails)
- [18. Appium Grid supports fewer commands](#18-appium-grid-projects-support-fewer-commands-than-appium-server)
- [19. `find_elements` details 20 matches](#19-find_elements-details-only-the-first-20-matches)
- [25. Android Auto and CarPlay](#25-android-auto--carplay-verification)
- [29. iOS differs from Android](#29-ios-inspection-sessions-differ-from-android)
- [31. Audio play and record](#31-audio-playrecord-needs-an-audio-line-and-appium-server)
- [36. HAR capture under NV tunneling](#36-har-capture-records-nothing-under-nv-tunneling)
- [37. No image-based locators](#37-image-based-locators-are-not-available)
- [39. Browser sessions by browser](#39-browser-inspection-sessions-what-differs-by-browser)

**Creating tests**
- [17. Test Orchestrator](#17-test-orchestrator-known-issues)
- [32. Robot Framework templates](#32-robot-framework-templates-scope)
- [34. Two-phone call and SMS tests](#34-no-generated-template-for-two-phone-call-and-sms-tests)
- [40. Choosing the framework: where the server can ask and read](#40-choosing-the-test-framework-where-the-server-can-ask-and-read)

**Running tests**
- [1. Which test suites the server can run](#1-appium-test-execution)
- [38. Playwright](#38-playwright-known-issues)

**Results, reports and analysis**
- [4. Reporter filters and sorting](#4-reporter-api-date-filter-csrf-restriction)
- [16. Deleting test reports](#16-deleting-test-reports-depends-on-a-per-project-setting)
- [22. Public report links](#22-public-report-links-cannot-be-revoked)
- [23. Root cause analysis is read-only](#23-root-cause-analysis-is-read-only)
- [28. Performance transactions](#28-performance-transactions-prerequisites-delay-and-client-side-filtering)
- [35. Reports that hold a performance transaction](#35-reports-that-hold-a-performance-transaction-cannot-be-deleted)

**Usage and licenses**
- [6. Licenses are read-only](#6-license-management)
- [21. Usage reports: retention and size](#21-usage-reports-2-year-retention-large-exports)

**Projects, users and apps**
- [10. App updates: iOS plugins only](#10-application-update-via-patch-is-ios-plugins-only)
- [27. Users cannot be disabled](#27-no-user-disablelock-endpoint)

**Deployment, setup and platform version**
- [8. Backup API on SaaS](#8-backup-api-availability-on-saas)
- [15. File paths under Docker](#15-local-file-io-runs-on-the-mcp-servers-filesystem-not-yours)
- [20. Debug-mode notes under Docker](#20-debug-mode-notes-need-a-client-that-can-write-files-docker)
- [24. Features that need a newer platform](#24-features-that-depend-on-the-platform-version)

---

## 1. Appium Test Execution

The platform has no REST API that starts an Appium (or Selenium) test suite. Those suites are started by Appium
clients (IDE plugins, CI scripts). This server manages the devices, apps and reservations they use, and opens its own
inspection sessions, but it does not run your Appium suite.

**Espresso, XCUITest and Maestro suites are different:** the platform runs them itself through the Test Run API — see
`execute_test_run`, `get_test_run_status`, `cancel_test_run` and `get_test_run_command`. Maestro is Android-only and its
bundle must be a ZIP containing a `flows/` directory. **Playwright** projects run through the platform's Execution
Service with `execute_playwright_run` (see limitation 38).

- Espresso and Maestro runs are verified end to end. XCUITest runs follow the platform's Test Run API reference but
  have not yet been verified end to end.
- Espresso can only instrument an app signed with the same key as the test APK, so it cannot drive preinstalled apps
  (Settings, Messages). Use UiAutomator for those, and set `useUIAutomator: true` for any suite that uses UiAutomator —
  without it those tests fail with "UiAutomationService … already registered".
- An app or test APK uploaded with a run is not added to the application repository.
- `get_test_run_status` waits at most 50 seconds per call; call it again to keep waiting.

## 2. Remote Debug Session Initiation

The "debug" web control mode (`start_device_web_control` with `mode: 'debug'`) needs the Digital.ai Grid to run as the
same user who called the API. The platform enforces this, and it cannot be worked around through the API.

## 3. Shared Devices Not Supported by Device APIs

Devices marked as "shared" in Digital.ai may not be fully manageable through the standard device APIs; their behaviour
and availability depend on platform configuration. To see how many tests ran on shared versus dedicated devices, group
test reports by `device.pool.actual` (platform 26.7+).

## 4. Reporter API: Date Filter CSRF Restriction

The Reporter API sends some filter properties through CSRF-protected middleware, which blocks them for every role:
`start_time`, `create_time` and `uuid`.

- **Date ranges:** use `startDate` / `endDate` on `list_test_reports`. It fetches records newest first and compares the
  dates in the server. For counts, `get_grouped_test_reports` takes `days`, or `startDate` / `endDate`, and gives exact
  counts for the range.
- **One report by UUID:** use `get_test_report`, which looks it up directly by UUID (or by the report URL printed in
  tearDown).

Filter properties confirmed to work: `status`, `name` (with `contains`), `has_attachment`, `success` (boolean),
`test_id`, `project_id`, `device.os`, `duration`, `attachment_count`, `attachments_size`, `status_code`,
`accessibility_report` (a JSON boolean — the string `"true"` is rejected) and `rca.status`.

- `status` takes six values: Passed, Failed, Error, Incomplete, Skipped and Healed. `success` is false for Healed runs,
  so filter on `status` rather than `success` when counting passes.
- **Letter case:** an equality filter in `list_test_reports` matches one spelling only (`device.os = "android"` and
  `= "Android"` find different runs). Grouped counts (`get_grouped_test_reports`, `get_distinct_test_key_values`) and the
  report tools ignore letter case; pass `exactCase: true` to `get_grouped_test_reports` to match one spelling.

**Sort** (`start_time` and other fields) is attempted for every role. If the platform refuses it for a credential, the
server retries without it, and the tools that need newest-first results (`find_latest_test_for_name`,
`get_test_stability_report`, `get_project_test_summary`, and `list_active_test_executions` when it falls back to
Reporter) scan up to 5,000 records and sort them in the server. The results are correct, but slower on large report
sets.

## 5. Region Management

Cloud Admins can list and inspect regions (`list_regions`, `get_region_topology`). Creating, editing or deleting
regions is not in the public REST API; do it in the Digital.ai web UI.

## 6. License Management

Cloud Admins can read license limits with `get_license_info` and current usage against those limits with
`get_license_utilization`. Buying, upgrading or changing entitlements is not available through the API; contact
Digital.ai.

## 7. Device Reboot and Cleanup Limitations for Non-Admin Users

`reboot_device` and `reset_device_usb` are Cloud Admin only. Project Admin and Project User keys cannot trigger
hardware-level device operations.

## 8. Backup API Availability on SaaS

The backup API (`create_backup`) may not be available on every Digital.ai SaaS tier. Confirm with your Digital.ai account
team before relying on it for automated backups.

## 9. Default and Cleanup Device Groups Cannot Be Deleted

`delete_device_group` returns an error for the "Default" and "Cleanup" device groups. The platform manages these groups
and needs them.

## 10. Application Update via PATCH is iOS Plugins Only

`update_application_plugins` uses the platform's PATCH endpoint, which only updates the signing profiles of iOS app
extensions (plugins). It cannot change notes, `uniqueName` or other metadata; to change those, upload the app again.

## 11. Device Reservation Timestamp Formats

Endpoints under `/api/v1/devices/` use a custom timestamp format, `YYYY-MM-DD-hh-mm-ss` (for example
`"2024-01-15-13-30-00"`). Endpoints under `/api/v1/device-reservations` use ISO 8601 (for example
`"2024-01-15T13:30:00Z"`).

You do not need to handle this: every tool takes ISO 8601, and the server converts where needed.

## 12. No Session-Free Screenshot REST API

The platform has no REST endpoint that captures a device screenshot outside a live WebDriver session. Every device
screenshot path (`/api/v1/devices/{id}/screenshot`, `/api/v2/devices/{id}/screenshot` and variants) returns HTTP 404,
confirmed against the production API.

To see a device screen, hold a live session:

- **Mobile:** `start_inspection_session` + `take_inspection_screenshot` (Android and iOS — see
  [Mobile Inspection Sessions](tools.md#mobile-inspection-sessions)).
- **Browser:** `start_browser_inspection_session` + `take_inspection_screenshot` (see
  [Web Inspection Sessions](tools.md#web-inspection-sessions)).
- **Without a session:** the Mobile Studio browser UI (`open_mobile_studio`, for a person, not the agent), or Android
  Studio Layout Inspector over an rdb connection.

After a test, its screenshots, video and logs are available from:

- `download_test_attachments` — writes to the MCP server's filesystem (see limitation 15);
- `download_test_video` — the video only, with optional byte ranges;
- `get_test_attachments_download_command` — a command you run to download the ZIP to your own machine;
- `get_test_log` — the Appium/device log text in the answer, no download.

## 13. `get_remote_debug_command` Requires Cloud Admin for Reliable Serial Resolution

With a Project Admin or Project User profile active, the device serial lookup can return the platform's internal
numeric device ID instead of the device's real serial or UDID. The generated `start-rdb` script then passes that ID to
`rdb start-remote-debug --serial-number`, and rdb rejects it ("validation error / Failed to reserve device").

With a project role, pass the device's real serial (Android) or UDID (iOS) yourself as `serialNumber` (read it from
Mobile Studio or `list_devices`), or ask your Cloud Admin to generate the script. If you also hold a **Cloud Admin**
profile, `switch_environment` to it, generate the script, then switch back. The tool warns you before you run the script: its answer carries an auth warning (`authWarning` in JSON
output) when the active role, as reported by the platform, is below Cloud Admin, or when the resolved serial is a purely
numeric internal ID.

## 14. Android 15+ Samsung Devices: UIAutomator Dump Silently Fails

On Android 15, and on some Android 13 Samsung devices (for example Galaxy S20 Ultra), `adb shell uiautomator dump` exits
without output and writes no XML file. This is an Android restriction on UiAutomation, not a Digital.ai one.

On these devices, inspect the UI another way:

- `open_mobile_studio` — the Mobile Studio session viewer is not affected;
- Android Studio Layout Inspector (Tools → Layout Inspector) — also not affected;
- as a last resort, `aapt dump xmltree` and `aapt dump resources` on the installed APK, which give the static resource
  IDs.

## 15. Local File I/O Runs on the MCP Server's Filesystem, Not Yours

**This applies only when the server runs in Docker or on another machine ([Option B or C](../README.md#installation)).**
With the recommended [npm install](../README.md#option-a--install-via-npm-recommended) (Option A) the server runs on
your own machine, so its filesystem is yours: the `download_*` and `upload_*` tools work directly with your local paths.
The server detects this by itself (outside a container it runs in local mode) and every affected tool's description
says which case applies. The rest of this section is about Docker and remote deployments.

Every tool that reads or writes a local path works on the **MCP server process's own filesystem**. In the Docker image,
or any remote deployment, that is the container's filesystem — not your machine, and not visible to the agent's own
shell and file tools. A `download_*` tool that reports success has written the file *inside the container*; an
`upload_*` tool reads from *inside the container*. Typical symptoms: a download succeeds but you cannot find the file,
or a Windows path is rejected as "not absolute" by the Linux container.

The server and your shell share no filesystem unless a folder is mounted into the container. Two workarounds are built
in:

- **Command tools.** Every file-transfer tool has a `get_*_upload_command` / `get_*_download_command` companion that
  returns a `curl` / PowerShell command you run **on your own machine**. It moves the file directly between your machine
  and the platform, bypassing the container. The command contains the active access key in plain text, so run it
  straight away and do not save it.
- **Text in the answer.** `get_test_log` returns the Appium, device or WebSocket log in the tool's answer, and
  `summarize_usage_report` returns a usage summary instead of a file — no file and no command.

If you mount a shared folder into the container, the `download_*` and `upload_*` tools work normally with paths in that
folder.

## 16. Deleting Test Reports Depends on a Per-Project Setting

Cloud Admins can delete test reports in any project. Project Admins and Project Users can delete them only when the
project's **`allowUsersDeleteTests`** setting is on; otherwise the platform answers `403 "You have no permission to delete
tests"`. A Cloud Admin manages the setting, and it is **off by default**.

The report-deletion tools (`delete_test_reports`, `delete_test_reports_before_date`, `delete_test_reports_by_name`,
`cleanup_inspection_sessions`, `cleanup_browser_inspection_sessions`) check this before doing anything:

- **Project Admin:** if the setting is off, the tool stops with a message naming the project and asking you to have a
  Cloud Admin turn on `allowUsersDeleteTests` (or to switch to a Cloud Admin profile).
- **Project User:** cannot read the setting, so the request goes to the platform, which answers with its own 403 if
  deletes are off.

## 17. Test Orchestrator: Known Issues

The Test Orchestrator wiring that `get_test_boilerplate` generates for Java on Appium Server was validated end to end on
real devices (Android TestNG with Gradle; Android JUnit 5 and iOS JUnit 5 with Maven): the agent attached, retried
failed tests in fresh sessions, numbered the attempts and recorded the Build ID in Reporter. Two platform-side issues
affect the **Reporter status** the agent sets:

- **Older JDK builds cannot reach Reporter.** The agent reports each test's result over HTTPS using the JDK's own
  truststore. The cloud's certificate chains to *SSL.com TLS RSA Root CA 2022*, which older JDK builds (for example
  21.0.2) do not include. There every status update fails silently ("Async cloud API call failed" in
  `smart-agent/<run-id>/*.log`) and Reporter shows the Appium session's status instead — so a failed assertion can
  appear as **Passed**. Use a current Java 17 or 21 update (Temurin 21.0.12 includes the root; OpenJDK 21.0.2 does not),
  or add the root CA to the truststore the tests run with.
- **iOS + JUnit 5: a failed test can still show as Passed.** On iOS the agent sent the correct "Failed" status and the
  platform accepted it, but the record still showed "Passed"; a later identical update was kept, which suggests the
  platform finalises the iOS report after the agent's update. Android (TestNG and JUnit 5) is not affected. The local
  result (Gradle or Maven) is always correct; rely on it rather than Reporter for iOS JUnit 5 until this is fixed in the
  platform.

The agent is currently a **1.0-SNAPSHOT** build and is not shipped with this server: `install_test_orchestrator_agent`
downloads it on demand from the Digital.ai sample repository, pinned to a fixed commit and checked by SHA-256. Without
network access to that location, install it by hand (the tool's error message gives the URL, checksum and target path);
the generated project builds and runs normally until then.

## 18. Appium Grid Projects Support Fewer Commands than Appium Server

Projects on the legacy Appium Grid (`isAppiumOss=false`) reject several things Appium Server accepts. `get_server_info`
shows which one your project uses.

Not available on the Appium Grid:

- the iOS locators `-ios predicate string` and `-ios class chain` (use accessibility id or XPath);
- Android Auto / CarPlay projection (the capability is accepted, but every projection command fails);
- pinch/zoom and the alert commands;
- clipboard and app-state queries on iOS devices;
- webview contexts (`webview_context` lists NATIVE_APP only);
- the `app_control` actions `background`, `is_installed` and `install`;
- device diagnostics, appearance switching and the accessibility audit;
- ADB shell (`device_control` action `shell`);
- audio play and record (`audio_control`, see limitation 31);
- Robot Framework mobile tests (see limitation 32).

Other differences:

- Platform commands that take no arguments (geolocation reset, steps-group stop, stopping HAR and device-log capture,
  webview-cache reset) **do** run on the Grid: the server sends them in the Grid's inline form.
- The Grid has no launch-by-package command, so `launch_app` on an Android Grid session needs the launch activity
  (`mainActivity` from `get_application_info`).
- The Grid rejects session requests without legacy `desiredCapabilities`, so the generated WebdriverIO project pins
  wdio 7.40 for Grid projects (wdio 8 and later are refused) and uses wdio 9 for Appium Server.

## 19. `find_elements` Details Only the First 20 Matches

To stay inside the MCP client's call timeout (about 60 seconds), `find_elements` reads attributes for at most
`maxResults` matches (default 20), within about 35 seconds. Further matches are returned by element ID only. Narrow the
selector rather than raising `maxResults` — on a busy iOS screen a broad query can otherwise take minutes.

## 20. Debug-Mode Notes Need a Client That Can Write Files (Docker)

With the npm install, `MCP_DEBUG_MODE=true` writes the event log and the notes straight into the project the AI client
is working in (or the folder the server was started in, when that is a project). If it finds no project folder, it keeps
the event log in memory and returns each note to the AI, as under Docker.

Under Docker the server cannot write to your project. It keeps the event log in memory and returns each note to the AI
to save in a `remediation/` folder at the root of the project it is working in. A client without file-writing tools
(for example Claude Desktop without a filesystem tool) cannot save them, so those notes are lost.

## 21. Usage Reports: 2-Year Retention, Large Exports

The usage-report tools (`download_usage_report`, `get_usage_report_download_command`, `summarize_usage_report`) are Cloud
Admin only.

- **Retention:** usage data is kept for 2 years (platform 25.9+). Earlier periods come back empty or partial, which does
  not mean there was no usage.
- **Size:** an unfiltered export of more than 31 days can reach hundreds of MB, so the tools stop and ask first. Only you
  can approve such an export (`confirmLargeExport`), never the agent on its own.
- `License Usage` has no project or user filter, so it always covers the whole platform.

## 22. Public Report Links Cannot Be Revoked

`share_test_report` creates a link anyone can open without logging in: the report, its key-value data and its video.
The link expires 14 days after it was first created, sharing again does not extend it, and the only way to disable it
early is to delete the report. Sharing fails if it is turned off for the project.

## 23. Root Cause Analysis Is Read-Only

`get_root_cause_analysis` reads existing analyses but cannot start one. Analyses are started from the video report in the
Reporter UI, cover Appium tests only (Appium Server, and Appium Grid from platform 26.9), and allow 3 failed attempts per
test.

## 24. Features That Depend on the Platform Version

- **26.7+:** the shared vs dedicated device-pool breakdown (`device.pool.actual`); older runs show as not recorded.
- **26.2+:** User Tag columns in usage reports.
- **26.9+:** crashes and infrastructure aborts are reported as Error rather than Incomplete, so status counts that span the
  upgrade mix both conventions.
- **Appium Server 3.8.1 (26.9+)** needs iOS 17 or later. On an iOS 15 or 16 device the session fails after about a minute
  with `DeviceOSVersionTooLow`; use 3.8.0 there.

## 25. Android Auto / CarPlay Verification

**Android Auto** projection is verified on Android phones in Appium Server projects.

**CarPlay** follows the platform documentation but has not been verified live. A 2026-10-14 attempt on an iPhone 13 Pro
Max attached to a CarPlay-enabled host failed on both routes with the platform's own "DEADLINE_EXCEEDED after 60 s" from
the host's projection service, before and after accepting the phone's one-time "Allow CarPlay with 'CarPlay Simulator'"
consent dialog. This is a host-side condition and was reported to the platform team. Two facts from that attempt are
built into the tools:

- the first CarPlay connection on a phone needs that consent dialog accepted (`take_inspection_screenshot`, then tap
  Allow);
- the platform allows one projection `start` per session, even after a failed attempt, so retry in a new session.

For both:

- Starting projection mid-session fails on some devices (for example Galaxy S10 / Android 12); start the session with
  `automotiveProjection` instead.
- Projection is not available in Appium Grid projects (see limitation 18).
- Projection needs a device attached to an Apple Silicon device host. On other devices, session creation fails with
  "Automotive Projection is only supported on Apple Silicon Device Host Machines", and not every device in the farm
  qualifies. When you ask for projection without naming a device or query, the server already limits the choice to
  Android 10+ devices; it cannot tell which hosts are Apple Silicon.

## 26. No Fold/Unfold Control for Foldable Devices

Digital.ai 26.9 added fold/unfold as a Mobile Studio action only. There is no documented automation command and the
Appium drivers have no fold command, so no tool in this server offers it. Use Mobile Studio (`open_mobile_studio`) for
foldable scenarios.

## 27. No User Disable/Lock Endpoint

The platform API cannot disable or lock a user account. Taking away a user's access means removing them from the
project or deleting the account. That is why the wind-down workflows delete accounts that belong only to the project
being closed: `close_project_resources` (with a confirmation for each user) and `teardown_project`.

## 28. Performance Transactions: Prerequisites, Delay and Client-Side Filtering

- **NV server required.** Performance transactions are recorded only when a Network Virtualization (NV) server is ONLINE
  and tunnel-connected in the device's region — check with `list_nv_servers(region=…)` before an instrumented run. NV
  profile names (such as `Monitor`, which observes without throttling) are set up on the NV server by your platform
  admin and can differ between deployments.
- **Reporting delay.** A transaction appears in Reporter about a minute after `endPerformanceTransaction`;
  `list_transactions` returns nothing if you query straight after the run.
- **No server-side filtering.** The platform returns every transaction record in one response, so each filter on
  `list_transactions`, `get_transaction_performance_summary` and `get_performance_trend` is applied by this server after
  it fetches the full set — slower on tenants with many transactions.
- **Project scope.** Project Admin and Project User keys see only their own project's transactions.

## 29. iOS Inspection Sessions Differ from Android

- **No Back button.** `press_back` taps the navigation bar's back button and falls back to a left-edge swipe. On the
  Appium Grid a synthetic edge swipe does not trigger the system back gesture.
- **No clearing app data.** `app_control` `clear_data` is Android-only; on iOS uninstall and reinstall the app instead.
- **Appium Grid iOS devices** also lack clipboard and `query_state` (see limitation 18).

## 30. Emulator and Simulator Templates Have No Region Data

`list_virtual_device_templates` lists the emulator and simulator templates the platform can start. An idle template is
not a device, so `list_devices`, `list_agents` and `get_agent_devices` never show it; a virtual device appears there only
while a session runs on it.

- The platform does not say which region or agent serves a template. To target a region, add `@region` to the
  template's `deviceQuery` and start a session.
- Virtual devices boot inside the session request, so a session on an `@emulator='true'` query can take two minutes or
  more to start. The server waits up to 240 seconds for such queries; set `INSPECTION_SESSION_TIMEOUT_MS` in the server
  environment to change that.

## 31. Audio Play/Record Needs an Audio Line and Appium Server

- `audio_control` works only on devices with an audio line configured. Find one with
  `find_available_device(requireAudioLine: true)`; other devices fail with "Audio line is not configured".
- It is available in Appium Server projects only: audio has been verified there, not on the Appium Grid, so the tool
  refuses Grid sessions.
- A recording made while the device played no sound is empty (a header-only WAV file, reported as `headerOnly`).
- One `play` call with `durationSeconds` plays for at most 45 seconds, so it finishes inside the client's call timeout.
  For a longer clip call `play`, then `stop_play`.

## 32. Robot Framework Templates: Scope

- **Mobile:** the Robot Framework option of `get_test_boilerplate` (`language: 'robot'`, AppiumLibrary) is for Appium
  Server projects only and cannot be combined with `includePerformanceTransactions`, `includeAxeScan` or
  `automotiveProjection`.
- **Web:** `get_web_test_boilerplate` with `language: 'robot'` (SeleniumLibrary) does not support Opera and has no
  shadow-DOM query helper.

## 33. Device Queries Are Limited to 255 Characters

The platform refuses session device queries longer than 255 characters. `start_inspection_session` counts the whole
query, including the `@region` clause it adds, and refuses an over-long query before contacting the platform. Keep
queries short: to target one device, use `@serialNumber` or `@name` rather than a long list of `or` alternatives.

## 34. No Generated Template for Two-Phone Call and SMS Tests

Tests in which one device calls or messages another (voice calls, SMS, MMS) have no `get_test_boilerplate` template.
Start from the reference project at https://github.com/dai-continuous-testing/UseCase-SIM-Card-Tests. Both devices need
SIM cards, and calls and SMS must be enabled for the project (`set_telephony_status`, Cloud Admin).

## 35. Reports That Hold a Performance Transaction Cannot Be Deleted

Once a session has recorded a performance transaction, the platform refuses to delete its report (a server-side
persistence error). `stop_inspection_session` and the delete tools give the reason and the report stays. Delete it from
the Reporter UI once the transaction is no longer needed.

## 36. HAR Capture Records Nothing Under NV Tunneling

`session_capture` with `kind: "har"` writes a HAR file into the file repository, but the platform records no HTTP
entries while NV tunneling is on for the device — which on many clouds is every device. The result
is a ZIP of about 290 bytes holding an empty `har.json`, and the tool says so. For network byte counts, use a performance
transaction instead.

## 37. Image-Based Locators Are Not Available

The Appium image-comparison plugin is not loaded on the cloud agents, and an element find with the `-image` strategy
ends the agent's Appium process for the rest of the session (every later command fails with a connection error). The
inspection tools do not offer the strategy; do not use it in generated tests either.

## 38. Playwright: Known Issues

**Execution Service runs (`execute_playwright_run`).**

- The platform runs the project in Microsoft's Playwright container image, which needs a **Cross Browser license** on a
  Digital.ai-hosted (SaaS) cloud.
- A run can show `RUNNING` for several minutes before its first test starts, while the container starts and installs
  the project's packages; a one-test run took about six minutes end to end.
- Each test becomes one Reporter record (find them with `test.run.id`), and `get_test_run_status` shows passed and
  failed once the run has finished. A complete run was verified end to end on 2026-11-26; that run had one Chromium
  test.
- Without free capacity a run stays `QUEUED` with the reason "Waiting for licenses", which `get_test_run_status` shows.
  Cancel the run with `cancel_test_run` and ask your cloud administrator.
- `imageVersion` must be a published Playwright version (for example `1.49.0`); an unknown one is rejected straight away.

**Playwright on the Selenium agent (`get_web_test_boilerplate` `language: "playwright"`)** — an **experimental**
platform feature:

- Chrome and Microsoft Edge only. For Firefox or WebKit, use `execute_playwright_run`.
- The Digital.ai report holds one record per browser session and shows **Passed even when a Playwright test failed**.
  The Playwright list or HTML report is the source of truth.
- Playwright drives the cloud browser over the Chrome DevTools Protocol, so keep `@playwright/test` close to the cloud
  browser version. The generated project pins 1.65.0, verified against Chrome 158 and Edge 157.
- The generated configuration connects through `SELENIUM_REMOTE_URL` / `SELENIUM_REMOTE_CAPABILITIES`. A
  `connectOptions.wsEndpoint` pointing at `/wd/hub` did not connect with Playwright 1.65.0 ("does not look like a
  Playwright server").
- The generated configuration switches targets by itself: inside the Playwright container that `execute_playwright_run`
  uses, it runs chromium, firefox and webkit and needs no key (it detects the container by `PLAYWRIGHT_BROWSERS_PATH`,
  which Microsoft's image sets). Locally, `DIGITAL_AI_PLAYWRIGHT_TARGET=local` selects the same browsers. The container
  switch has not yet been seen running on a live Execution Service job.

## 39. Browser Inspection Sessions: What Differs by Browser

- **Console and network log (`get_browser_log`)** — captured over WebDriver BiDi on desktop Chrome, Edge, Firefox and
  Opera. Not on Safari (Safari never answers a session request that asks for BiDi, so the server does not ask) and not
  on mobile browsers.
- **Mobile browsers (`mobilePlatform`)** — Chrome on Android and Safari on iOS, in Appium Server and Appium Grid projects.
  Allocating a phone takes about 25–55 seconds. iOS Safari does not honour `acceptInsecureCerts`: a site with a
  self-signed certificate still shows "This Connection Is Not Private" (Android Chrome and the desktop browsers load it).
- **`acceptInsecureCerts`** is verified on desktop Chrome, Firefox, Edge and Safari, and on Android Chrome; not on Opera.

## 40. Choosing the Test Framework: Where the Server Can Ask and Read

The user chooses the test framework once per project (see
[Choosing the test framework](../README.md#choosing-the-test-framework)). Two parts of that depend on the AI client:

- **Asking the user directly.** The server puts the question to the user with a choice form only in clients that
  support MCP elicitation. In other clients the AI is told to ask the user in the conversation; an AI can ignore that
  instruction and pass a language on its own. If that happens, tell it which framework you want, or set it again.
- **Reading your project.** The recommendation reflects the build files and test frameworks already in your project only
  when the server runs on your machine (the npm install) and the client shares its workspace folder with the server
  (Claude Code, VS Code). Claude Desktop does not share a folder, and a server in Docker cannot read your disk, so there
  the recommendation comes from the cloud project alone.

## 41. App Exploration (Beta): What It Does Not Do Yet

`start_app_exploration` maps an app's screens in the background. In this beta:

- **Verified on Android (Appium Server) only.** iOS and Appium Grid projects are not yet verified.
- **Web content is not crawled.** Screens inside a web view are listed as they appear in the native tree; the crawler does not switch contexts.
- **Nothing is typed.** Forms are opened (when write paths are allowed) but never filled or submitted, so screens behind a filled form are not reached.
- **Test logins:** save one with `setup app-login <name>` (password in the OS keychain), or name two environment variables set in the server's entry in your AI client's configuration. AI clients usually pass only the variables in that entry, not your whole system environment, so `setx` alone does not reach the server. A login typed into the chat is not used.
- **Destructive actions are never tapped**, whatever the session setting: they are listed for you to confirm one by one.
- **A running exploration lives in the server process.** Restarting the server or the AI client ends it; a FINISHED one is saved and can be resumed.
- **Resuming relies on the app returning to the same screens by the same taps.** A route that no longer reaches its screen (the app changed, or another phone draws it differently) is reported and skipped, not guessed.
- **Two builds with the same package, release and build version in one project cannot be told apart:** the platform installs one of them, and the manifest says so.
- **Screens are told apart by structure.** Two visits to one screen in different states (an expanded list, a filled field) can appear as two screens.
