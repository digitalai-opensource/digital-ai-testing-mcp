# Known Limitations

## 1. Appium Test Execution

There is no REST API to trigger Appium (or Selenium) test execution directly. Those tests are launched from Appium clients (IDE plugins, CI scripts) — this MCP server manages the devices, apps and reservations they use and can open its own inspection sessions, but does not run a user's Appium suite.

**Espresso, XCUITest and Maestro suites are different:** the platform runs them itself through the Test Run API — see `execute_test_run`, `get_test_run_status`, `cancel_test_run` and `get_test_run_command`. Maestro is Android-only and its bundle must be a ZIP containing a `flows/` directory.

XCUITest runs follow the platform's Test Run API reference but have not yet been verified end to end (Espresso and Maestro have). Espresso can only instrument an app signed with the same key as the test APK, so it cannot drive preinstalled apps (Settings, Messages); use UiAutomator for those, and set `useUIAutomator: true` for any suite that uses UiAutomator — without it those tests fail with "UiAutomationService … already registered". An app or test APK uploaded with a run is not added to the application repository. `get_test_run_status` waits at most 50 seconds per call; call it again to keep waiting.

## 2. Remote Debug Session Initiation

The "debug" web control mode (`start_device_web_control` with `mode: 'debug'`) requires the Digital.ai Grid to be running as the same user who called the API. This constraint is enforced by the platform and cannot be worked around through the API.

## 3. Shared Devices Not Supported by Device APIs

Devices designated as "shared" in Digital.ai may not be fully managed through the standard device APIs. Shared device behavior and availability depend on platform configuration. To see how many tests ran on shared versus dedicated devices, group test reports by `device.pool.actual` (platform 26.7+).

## 4. Reporter API: Date Filter CSRF Restriction

The Digital.ai reporter API routes certain filter properties through CSRF-protected middleware. The following are blocked for all callers (Cloud Admin, Project Admin, and Project User): `start_time`, `create_time`, `uuid`. For date-range filtering, use the `startDate`/`endDate` parameters on `list_test_reports` — these fetch records newest-first (server-sorted for every role, falling back to a capped full scan only if the platform refuses sort for a credential) and apply the date comparison client-side.

Confirmed working filter properties: `status`, `name` (with `contains`), `has_attachment`, `success` (boolean), `test_id`, `project_id`, `device.os` (case-sensitive), `duration`, `attachment_count`, `attachments_size`, `status_code`, `accessibility_report` (JSON boolean — the string `"true"` is rejected), `rca.status`. `status` takes the six values Passed, Failed, Error, Incomplete, Skipped and Healed; `success` is false for Healed runs, so filter on `status` rather than `success` when counting passes.

**Sort** (`start_time` and other fields) is attempted for every role. If the platform refuses it for a credential, the server automatically retries without it and tools that need newest-first results (`find_latest_test_for_name`, `get_test_stability_report`, `get_project_test_summary`, `list_active_test_executions`) fall back to scanning up to 5,000 records and sorting client-side — correct results, but slower on large report sets.

## 5. Region Management

Listing and inspecting regions is available via the v2 API (`list_regions`, `get_region_topology`) — Cloud Admin only. However, **creating, editing, or deleting regions** is not exposed via the public REST API; region configuration is done through the Digital.ai web UI.

## 6. License Management

License **limits** are readable via `get_license_info` and current usage vs. limits via `get_license_utilization` — Cloud Admin only. License **purchasing, upgrading, or modifying entitlements** is not available through the API; those operations require contacting Digital.ai.

## 7. Device Reboot and Cleanup Limitations for Non-Admin Users

`reboot_device` and `reset_device_usb` are Cloud Admin-only operations. Project Admin and Project User keys cannot trigger hardware-level device operations.

## 8. Backup API Availability on SaaS

The backup API (`create_backup`) may not be available on all Digital.ai SaaS tiers. Confirm availability with your Digital.ai account team before relying on it for automated backup workflows.

## 9. Default and Cleanup Device Groups Cannot Be Deleted

The `delete_device_group` tool will return an error if you attempt to delete the "Default" or "Cleanup" device groups. These are system-managed groups that the platform requires.

## 10. Application Update via PATCH is iOS Plugins Only

The `update_application_plugins` tool uses the PATCH endpoint and only supports updating iOS app extension/plugin signing profiles. It does not support updating app notes, uniqueName, or other metadata fields. For those fields, you would need to re-upload the app.

## 11. Device Reservation Timestamp Formats

Endpoints under `/api/v1/devices/` use a custom timestamp format: `YYYY-MM-DD-hh-mm-ss` (e.g. `"2024-01-15-13-30-00"`).

Endpoints under `/api/v1/device-reservations` use standard ISO 8601 format (e.g. `"2024-01-15T13:30:00Z"`).

Both formats are handled automatically by this MCP server — you always provide ISO 8601 in tool inputs, and the server converts as needed.

## 12. No Session-Free Screenshot REST API

The Digital.ai Testing platform does not expose a REST endpoint for capturing a device screenshot outside of a live WebDriver session. All device screenshot paths (`/api/v1/devices/{id}/screenshot`, `/api/v2/devices/{id}/screenshot`, and variants) return HTTP 404. This has been confirmed by live probe against the production API.

To observe a device screen, the AI agent must hold a live WebDriver session: `start_inspection_session` + `take_inspection_screenshot` provide exactly this (Android and iOS — see the [Mobile Inspection Sessions](tools.md#mobile-inspection-sessions) reference). For browser screenshots, `start_browser_inspection_session` + `take_inspection_screenshot` provides equivalent functionality for cloud browsers (see [Web Inspection Sessions](tools.md#web-inspection-sessions)). Without a session, screen observation requires the Mobile Studio browser UI (developer-facing only) or Android Studio Layout Inspector via an rdb connection. Test attachments (screenshots, the session video, and logs captured during a test run) are available after the session ends via `download_test_attachments` (writes to the MCP server's filesystem), `download_test_video` (the video only, with optional byte ranges), `get_test_attachments_download_command` (a local-run command that lands the ZIP on your own machine — see limitation 15), or `get_test_log` (returns Appium/device log text inline, no download).

## 13. `get_remote_debug_command` Requires Cloud Admin for Reliable Serial Resolution

When the active `DIGITAL_AI_ACCESS_KEY` is a **project-level key** (Project Admin or Project User), the device serial lookup API may return an internal numeric ID rather than the actual device UDID. The generated `adb connect` command in the output script will use that internal ID, which the ADB server cannot resolve — the connection will fail silently or immediately disconnect.

Use a **Cloud Admin** profile when running `get_remote_debug_command` to ensure the device serial is resolved to the real UDID. The tool includes an `authWarning` field in its structured response when a project-level key is detected, flagging this condition before the script is written to disk.

## 14. Android 15+ Samsung Devices: UIAutomator Dump Silently Fails

On Android 15 (and some Android 13 Samsung devices, e.g. Galaxy S20 Ultra), `adb shell uiautomator dump` exits without output and produces no XML file. This is an OS-level restriction on UiAutomation introduced in later Android versions and is not specific to the Digital.ai platform.

On affected devices, use `open_mobile_studio` instead of the uiautomator dump path to inspect UI elements. The Mobile Studio browser session viewer is not subject to this restriction. Android Studio Layout Inspector (via Tools → Layout Inspector) is also unaffected. If neither option is available, APK inspection via `aapt dump xmltree` and `aapt dump resources` can extract static resource IDs from the installed APK.

## 15. Local File I/O Runs on the MCP Server's Filesystem, Not Yours

**Applies only to Docker/remote deployment ([Option B or C](../README.md#installation)) — not the recommended [npm install](../README.md#option-a--install-via-npm-recommended) (Option A).** Running the server directly with Node.js on your own machine, its filesystem **is** your filesystem — `download_*`/`upload_*` tools work directly against local paths, no workaround needed. Set `MCP_DEPLOYMENT_MODE=local` (see [Configuration](../README.md#configuration)) and every affected tool's description reflects this automatically. The rest of this section describes the Docker/remote case only.

Every tool that reads or writes a local file path operates on the **MCP server process's own filesystem**. In the published Docker image (or any remote deployment), that filesystem is the container's — **not** the caller's machine, and not visible to the agent's shell/file tools. A `download_*` tool that reports success has written the file *inside the container*; an `upload_*` tool reads from *inside the container*. A common symptom: a path that validates on the server writes to a location you cannot reach, or a Windows path is rejected as "not absolute" by a Linux container.

This is a deployment characteristic, not a fixable bug — the server and the caller's shell do not share a filesystem unless a directory is explicitly volume-mounted. Two mitigations are built in:

- **Command-generator siblings.** Every file-transfer tool has a `get_*_upload_command` / `get_*_download_command` companion that emits a `curl` / PowerShell command the user runs **locally**, moving bytes directly between their machine and the platform — bypassing the container entirely. (Endpoints verified live; the generated command embeds the active access key in plaintext, so it must be run immediately and not saved.)
- **Inline text for logs.** `get_test_log` returns Appium/device/ws log content directly in the tool response — no file, no command — which covers the most common diagnostic need without touching a filesystem at all.

When running the server with a shared/volume-mounted directory (e.g. bare-metal or a mounted Docker volume), the direct `download_*`/`upload_*` tools work normally against that shared path.

## 16. Deleting Test Reports Depends on a Per-Project Setting

Cloud Admins can delete test reports in any project. Project Admins and Project Users can only do so when the project's **`allowUsersDeleteTests`** setting is enabled; the platform otherwise answers `403 "You have no permission to delete tests"`. The setting is managed by a Cloud Admin and is **off by default**.

The report-deletion tools (`delete_test_reports`, `delete_test_reports_before_date`, `delete_test_reports_by_name`, `cleanup_inspection_sessions`, `cleanup_browser_inspection_sessions`) check this before doing any work. When a Project Admin's project has the setting off, the tool stops with a message naming the project and asking you to have a Cloud Admin enable `allowUsersDeleteTests` (or to switch to a Cloud Admin profile). A Project User cannot read the setting, so the request goes to the platform, which returns its own 403 if deletes are disabled.

Which role you hold is detected from the API, not from the format of your access key — see [Access Keys](../README.md#access-keys).

## 17. Test Orchestrator: Known Issues

The Test Orchestrator wiring that `get_test_boilerplate` generates for Java on Appium Server was validated end to end on real devices (Android TestNG via Gradle, Android JUnit 5 and iOS JUnit 5 via Maven): the agent attached, retried failed tests in fresh sessions, numbered the attempts and stamped the Build ID in Reporter. Two platform-side issues affect the **Reporter status** the agent syncs:

- **Older JDK builds cannot reach Reporter.** The agent reports each test's real result over HTTPS using the JDK's own truststore. The cloud's certificate chains to *SSL.com TLS RSA Root CA 2022*, which older JDK builds (for example 21.0.2) do not include. There, every status update fails silently ("Async cloud API call failed" in `smart-agent/<run-id>/*.log`) and Reporter shows the Appium session's status instead — a failed assertion can appear as **Passed**. Use a current Java 17/21 update (Temurin 21.0.12 includes the root; OpenJDK 21.0.2 does not), or add the root CA to the truststore the tests run with.
- **iOS + JUnit 5: a failed test can still show as Passed.** On iOS the agent sent the correct "Failed" status and the platform accepted it, but the record still showed "Passed". A later identical update was kept, which points to the platform finalising the iOS report after the agent's update. Android (TestNG and JUnit 5) was not affected. The local test result (Gradle/Maven) is always correct; rely on it rather than Reporter for iOS JUnit 5 until this is fixed upstream.

The agent itself is currently a **1.0-SNAPSHOT** build. It is not shipped with this server: `install_test_orchestrator_agent` downloads it on demand from the Digital.ai sample repository, pinned to a fixed commit and verified by SHA-256. Without network access to that location, install it manually (the tool's error message gives the URL, checksum and target path) — the generated project builds and runs normally until then.

## 18. Appium Grid Projects Support Fewer Commands than Appium Server

Projects on the legacy Appium Grid (`isAppiumOss=false`) reject several things Appium Server accepts: the iOS locator `-ios predicate string` (use xpath or accessibility id); Android Auto / CarPlay projection (the capability is accepted but every projection command fails); pinch/zoom, alerts and geolocation reset; and clipboard on iOS devices. The Grid also rejects session requests that lack legacy `desiredCapabilities`, so the generated WebdriverIO project pins wdio 7.40 for Grid projects (wdio 8+ is refused) and uses wdio 9 for Appium Server. Check `get_server_info` to see which mode your project uses.

## 19. `find_elements` Details Only the First 20 Matches

To stay inside the MCP client's ~60 s call timeout, `find_elements` fetches attributes for at most `maxResults` matches (default 20) within about 35 seconds. Further matches are returned by element ID only. Narrow the selector rather than raising `maxResults` — a broad query on a busy iOS screen can otherwise take minutes.

## 20. Debug-Mode Notes Need a Client That Can Write Files (Docker)

With `MCP_DEBUG_MODE=true` under Docker, the server cannot write to your project. The event log is kept in server memory and each note is returned to the AI to save in a `remediation/` folder at the root of the project it is working in. Clients without file-writing tools (for example Claude Desktop without a filesystem tool) cannot save them, so the notes are skipped. The npm install writes both files directly.

## 21. Usage Reports: 2-Year Retention, Large Exports

Usage data is kept for 2 years (platform 25.9+); earlier periods come back empty or partial, which is not evidence of zero usage. An unfiltered export spanning more than 31 days can reach hundreds of MB, so the tools stop and ask; only you can approve such an export (`confirmLargeExport`), never the agent on its own. `License Usage` has no project or user filter, so it is always platform-wide.

## 22. Public Report Links Cannot Be Revoked

`share_test_report` creates a link anyone can open without logging in — the report, its key-value data and its video. It expires 14 days after first creation, re-sharing does not extend it, and the only way to disable it early is to delete the report. Sharing fails if it is disabled for the project.

## 23. Root Cause Analysis Is Read-Only

`get_root_cause_analysis` reads existing analyses but cannot start one. Analyses are started from the video report in the Reporter UI, cover Appium Server tests only, and allow 3 failed attempts per test.

## 24. Features That Depend on the Platform Version

The shared vs dedicated device-pool breakdown (`device.pool.actual`) needs platform 26.7+ (older runs show as not recorded). User Tag columns in usage reports need 26.2+. From 26.9, crashes and infrastructure aborts are reported as Error rather than Incomplete, so status counts that span the upgrade mix both conventions.

## 25. Android Auto / CarPlay Verification

Android Auto projection is verified on Appium Server Android phones. CarPlay follows the platform documentation and has not been verified live. Starting projection mid-session fails on some devices (e.g. Galaxy S10 / Android 12) — start the session with `automotiveProjection` instead. Projection is not available on Appium Grid projects (see limitation 18). It also needs a device attached to an Apple Silicon device host; on other devices session creation fails with "Automotive Projection is only supported on Apple Silicon Device Host Machines", and not every device in the farm qualifies. When you request projection without naming a device or query, the server already limits the choice to Android 10+ devices; it cannot tell which hosts are Apple Silicon.

## 26. No Fold/Unfold Control for Foldable Devices

Digital.ai 26.9 added fold/unfold as a Mobile Studio UI action only. No documented automation command exists and the Appium drivers have no fold command, so no tool in this server exposes it. Use Mobile Studio (`open_mobile_studio`) for foldable scenarios.

## 27. No User Disable/Lock Endpoint

The platform API has no way to disable or lock a user account. Removing access for a user provisioned solely for a POC means deleting the account — which is why `close_poc` requires per-user confirmation.
