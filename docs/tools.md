# Tool Reference

Complete per-tool reference for the Digital.ai Testing MCP Server — all 187 tools, 2 resources, and 6 prompts, organized by capability domain. For setup, configuration, and usage guides, see the [main README](../README.md).

**Reading the tables:**
- **Admin Required?** — *Cloud Admin* requires a Cloud Admin credential (the long eyJ... key); *Cloud Admin / Project Admin* works for those two roles; *Any* works for all three roles (Cloud Admin, Project Admin, Project User). See [Access Keys](../README.md#access-keys).
- **Filters / Sort** — server-side parameters accepted by list tools. See [List Filters & Sorting](../README.md#list-filters--sorting).
- Destructive tools require `confirmDeletion: true` — see [Safety Guards](../README.md#safety-guards).

### Users

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_users` | List all user accounts | firstName, lastName, email, authenticationType, isCloudAdmin, tag; sortBy/sortOrder | Cloud Admin |
| `create_user` | Create a new user account | — | Cloud Admin |
| `delete_user` | Permanently delete a user account | — | Cloud Admin |
| `get_my_account_info` | Show the account tied to the active API key | — | Any |
| `assign_user_to_projects` | Grant user access to one or more projects | — | Cloud Admin |
| `unassign_user_from_projects` | Remove user from one or more projects | — | Cloud Admin |
| `get_user_tags` | List tags on a user | — | Cloud Admin |
| `set_user_tags` | Replace all tags on a user (max 10) | — | Cloud Admin |

### Devices

Device tools accept a **flexible device identifier**: numeric device ID, serial number, UDID, or device name — the server resolves it to the backend ID automatically.

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_devices` | List devices with status, OS, model, and agent | `query` (@-syntax), `region`, `model`; sortBy/sortOrder | Any |
| `get_device_detail` | Full device profile including groups and status history | — | Cloud Admin |
| `edit_device` | Update device name, notes, or category | — | Cloud Admin |
| `find_available_device` | Find the first available device matching OS, tags, or version | — | Any |
| `release_device` | Release a reserved or stuck device. Requires `confirmDeletion: true`. | — | Any |
| `release_orphaned_sessions` | Find and release devices stuck in "In Use" beyond a configurable time threshold | — | Any |
| `reboot_device` | Remote reboot | — | Cloud Admin |
| `reset_device_usb` | Reset USB connection | — | Cloud Admin |
| `start_device_web_control` | Open a browser-based control session | — | Cloud Admin |
| `open_mobile_studio` | Open the platform's browser-based UI Inspector for a device — shows live element tree with resource IDs, XPaths, and accessibility IDs. **Primary tool for element locator discovery before writing test code.** | — | Any |
| `create_mobile_manual_test` | Create a structured manual test session | — | Any |
| `download_ios_app_container` | Download an iOS app data container (writes to the MCP server's filesystem) | — | Cloud Admin |
| `get_ios_app_container_download_command` | Generate a curl/PowerShell command to download the iOS app container to the user's local machine — use when the server is Docker/remote | — | Cloud Admin |
| `get_device_health_summary` | Device farm health overview | — | Any |
| `get_device_tags` | List all tags on a device | — | Any |
| `add_device_tag` | Add a tag to a device | — | Cloud/Project Admin |
| `remove_device_tag` | Remove a specific tag | — | Cloud/Project Admin |
| `remove_all_device_tags` | Remove all tags | — | Cloud/Project Admin |
| `get_device_ca_certificates` | List CA certificates on an Android device | — | Cloud Admin |

**Device query syntax** (`list_devices` `query` parameter — server-side filtering):

```
@os='android'            @os='iOS'          (case-insensitive)
@version='14.0'          @version>'13.0'    (decimal required; supports =, >, <, !=)
@category='PHONE'        @category='TABLET' (uppercase required)
@region='US2'            @region='SG1'
@name='My Device'                           (exact display name)
@model='iPhone 12'       @modelName='Xiaomi Redmi Note 9 5G'
@serialNumber='4hlfov...'
@emulator='false'
```

Combine with `and`: `@os='android' and @category='PHONE' and @version>'13.0' and @region='US2'`

> **Fields that silently return empty results — do not use in queries:** `@manufacturer`, `@tag`, `@deviceName`, `@id`, `@udid`, `@status`, `@agentName`, `@location`, `@project`, `@group`. The API accepts these without error but returns nothing. Use the `manufacturer`, `tags`, `model`, and `region` parameters on `list_devices` and `find_available_device` instead — those filter client-side and reliably work.

### Device Groups

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_device_groups` | List all device groups. Full detail (device counts, type) with Cloud Admin; simplified id/name list with project-level keys. | Any |
| `get_devices_in_group` | List devices in a group | Cloud Admin |
| `get_projects_in_group` | List projects with access to a group | Cloud Admin |
| `create_device_group` | Create a new device group | Cloud Admin |
| `edit_device_group` | Rename or toggle auto-accept | Cloud Admin |
| `delete_device_group` | Delete a group (devices are not deleted) | Cloud Admin |
| `add_devices_to_group` | Add devices to a group | Cloud Admin |
| `remove_devices_from_group` | Remove devices from a group | Cloud Admin |
| `assign_group_to_project` | Grant a project access to a group | Cloud Admin |

### Reservations

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_reservations` | List current and upcoming reservations | username, project, deviceUid; sortBy/sortOrder | Any |
| `create_reservation` | Reserve one or more devices | — | Cloud/Project Admin |
| `reserve_device_for_duration` | Reserve a device for N hours starting now (e.g. `0.5` = 30 min, `1.0` = 1 hour) | — | Cloud/Project Admin |
| `delete_reservation` | Cancel a reservation | — | Cloud/Project/User |
| `check_device_availability_window` | Check a device's reservation schedule over a time window | — | Any |

### Applications

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_applications` | List all apps in the repository | nameContains, osType, packageName, bundleIdentifier, fileType, isForSimulator; sortBy/sortOrder | Any |
| `get_application_info` | Full app detail | — | Any |
| `find_latest_application` | Find the newest uploaded version by name, bundle ID, or package name. Returns `appCapabilityString` (e.g. `cloud:MyApp`) ready for the Appium `app` capability. | — | Any |
| `upload_application_file` | Upload APK/IPA/AAB from a local file path visible to the MCP container (volume-mount required). Project-level keys upload to their assigned project; use `project` to target a specific project (Cloud Admin only). | — | Any |
| `upload_application_from_url` | Upload from a direct-download URL. Project-level keys upload to their assigned project; use `project` to target a specific project (Cloud Admin only). | — | Any |
| `get_application_upload_command` | Generate a ready-to-run curl or PowerShell command for uploading a binary directly from the user's local machine — the MCP is not the middleman. Use when volume-mounting Docker is impractical. Embeds the active access key; instruct the user to run immediately and discard. | — | Any |
| `delete_application` | Delete an app from the repository | — | Cloud Admin |
| `update_application_plugins` | Update iOS plugin signing profiles | — | Cloud Admin |
| `install_application` | Install an app on one or more devices. The app must be assigned to a project containing the target device — call `assign_app_to_project` first if you get a 400 error. | — | Any |
| `uninstall_application` | Uninstall from one or more devices. Requires `confirmDeletion: true`. | — | Any |
| `uninstall_application_by_package` | Uninstall by package name on a single device. Requires `confirmDeletion: true`. | — | Any |
| `uninstall_application_by_package_from_devices` | Uninstall by package name across multiple devices. Requires `confirmDeletion: true`. | — | Any |
| `extract_app_language_files` | Download localization files from an app (writes to the MCP server's filesystem) | — | Any |
| `get_app_language_files_download_command` | Generate a curl/PowerShell command to download an app's language-file ZIP to the user's local machine — use when the server is Docker/remote | — | Any |
| `bulk_install_to_group` | Install on every device in a device group | — | Any |

> **Upload from URL:** Must be a direct-download link accessible from the Digital.ai server's network. Redirect URLs, auth-gated URLs, and unsupported file types return a 400 with a diagnostic message.

> **File uploads from Docker:** The MCP server runs inside a container. Mount the directory containing your build artifacts as a volume (e.g. `-v /host/apps:/apps`) and reference the container path (e.g. `/apps/myapp.apk`). Alternatively, use `upload_application_from_url` for artifacts already on a network-accessible URL.

### Repository

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_repository_files` | List files in the repository | Any |
| `get_repository_file_info` | Get file details by ID | Any |
| `upload_repository_file` | Upload a file (reads from the MCP server's filesystem) | Any |
| `get_repository_upload_command` | Generate a curl/PowerShell command to upload a file from the user's local machine — use when the server runs in Docker/remote and cannot read the local file | Any |
| `download_repository_file` | Download a file by ID (writes to the MCP server's filesystem) | Any |
| `get_repository_file_download_command` | Generate a curl/PowerShell command to download a repository file to the user's local machine — use when the server is Docker/remote | Any |
| `update_repository_file` | Replace file content in-place | Any |
| `delete_repository_file` | Delete a file | Any |

### Browsers

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_available_browsers` | List available browser/OS combinations | Any |
| `start_selenium_session` | Open a Selenium browser session | Any |
| `start_manual_test_session` | Create a structured browser test | Any |

### Projects

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_projects` | List all projects | name filter; sortBy/sortOrder | Any |
| `create_project` | Create a project | — | Cloud Admin |
| `delete_project` | Delete a project | — | Cloud Admin |
| `list_project_users` | List users in a project | username, role; sortBy/sortOrder | Cloud/Project Admin |
| `assign_user_to_project` | Add a user to a project with a role | — | Cloud Admin |
| `remove_user_from_project` | Remove a user from a project | — | Cloud Admin |
| `get_project_tokens` | Get token configuration | — | Cloud/Project Admin |
| `set_project_tokens` | Update token mode | — | Cloud Admin |
| `get_project_settings` | Basic project settings | — | Cloud/Project Admin |
| `get_project_admin_settings` | Full project configuration via v2 API — 35+ fields in one call: per-type license limits, cleanup flags, reservation policies, feature flags, user/app counts | — | Cloud Admin / Project Admin |
| `update_project_settings` | Update cleanup, concurrency, and limit settings | — | Cloud Admin |
| `set_telephony_status` | Enable/disable calls and SMS | — | Cloud Admin |
| `get_project_notes` | Get project notes | — | Any |
| `set_project_notes` | Set project notes | — | Cloud/Project Admin |
| `get_project_devices` | List devices accessible to a project | — | Cloud/Project Admin |
| `get_automation_properties` | Get Appium/automation properties | — | Any |
| `assign_app_to_project` | Make an app available to a project | — | Cloud Admin |

### Provisioning Profiles

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_provisioning_profiles` | List iOS signing profiles with expiry dates | Cloud Admin |
| `get_provisioning_profile` | Get profile details | Cloud Admin |
| `upload_provisioning_profile` | Upload P12 + mobileprovision (reads from the MCP server's filesystem) | Cloud Admin |
| `get_provisioning_profile_upload_command` | Generate a curl/PowerShell command to upload P12 + mobileprovision from the user's local machine — use when the server runs in Docker/remote | Cloud Admin |
| `download_provisioning_profile` | Download a profile (writes to the MCP server's filesystem) | Cloud Admin |
| `get_provisioning_profile_download_command` | Generate a curl/PowerShell command to download a profile to the user's local machine — use when the server is Docker/remote | Cloud Admin |
| `delete_provisioning_profile` | Delete a profile | Cloud Admin |

### Backup

| Tool | What it does | Admin Required? |
|---|---|---|
| `create_backup` | Trigger a live system backup | Cloud Admin |

### Health & Diagnostics

| Tool | What it does | Admin Required? |
|---|---|---|
| `get_environment_summary` | Full environment snapshot: devices, agents, groups | Any |
| `check_ios_readiness` | iOS device and provisioning profile readiness | Any |
| `get_agent_status` | Agent connectivity overview | Any |
| `get_server_info` | Server version, active profile, URL, tool count, and capability domains | Any |
| `check_connectivity` | Verify the MCP server can reach the Digital.ai API | Any |
| `check_workflow_readiness` | Readiness report for all workflow tools — which dependency tools are present or missing. Call this first when diagnosing workflow failures. | Any |
| `list_active_sessions` | Currently active browser/Selenium sessions | Cloud Admin |
| `get_reporter_project_storage` | Per-project disk usage: current MB, quota, usage %, artifact counts. Sorted by usage descending. | Cloud Admin |
| `get_license_info` | Platform license limits for devices and browser sessions | Cloud Admin |
| `get_license_utilization` | In-use counts vs. purchased limits | Cloud Admin |

### Coverage Analytics

| Tool | What it does | Admin Required? |
|---|---|---|
| `get_device_coverage_summary` | Compares farm inventory against test execution history — which OS versions, models, and manufacturers have been tested vs. available. Identifies gaps. | Any |
| `get_regional_test_coverage` | Infrastructure coverage by region: device counts, OS split, and availability rate per region | Any |

### Reporting

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_test_reports` | Search, filter, sort, and paginate test reports. See [Test Reporting Schema](../README.md#test-reporting-schema) for supported filters. | Any |
| `get_test_report` | Full test execution report by numeric test ID or reporter URL | Any |
| `get_test_by_report_id` | Report by `report_api_id` (returned when starting a session) | Any |
| `find_latest_test_for_name` | Most recent run record for a test by name | Any |
| `get_grouped_test_reports` | Pass/fail counts grouped by field (use `groupBy`, e.g. `["device.os"]`). Supports `pivotBy` for per-status columns. | Any |
| `get_test_stability_report` | Last N runs of a named test: pass rate, sparkline trend, and consecutive streak count | Any |
| `get_cross_platform_divergence` | Tests passing on one OS but failing on the other, with configurable minimum run count and divergence threshold | Any |
| `get_daily_execution_trend` | Execution counts and pass rates bucketed by day or week. Stops at `lookbackDays` or `maxRecords` (default 5,000; max 25,000), whichever comes first. | Any |
| `get_project_test_summary` | All-time pass/fail totals and top failing tests in a time window | Any |
| `get_failure_rate_by_app_version` | Pass/fail breakdown grouped by app version | Any |
| `get_distinct_test_key_values` | Discover all distinct values recorded for a report metadata key | Any |
| `list_active_test_executions` | Currently-running test executions (Incomplete status with null duration) | Any |
| `list_test_attachments` | Attachment metadata for a test by numeric ID | Any |
| `download_test_attachments` | Download test attachments as a ZIP file (writes to the MCP server's filesystem) | Any |
| `get_test_attachments_download_command` | Generate a curl/PowerShell command to download the attachment ZIP (session video .mp4 + logs) to the user's local machine — use when the server is Docker/remote | Any |
| `get_test_log` | Retrieve log content (Appium/device/ws) from a test directly as text — no file download; ideal for diagnosing failures | Any |
| `delete_test_reports` | Permanently delete test records by ID list | Cloud Admin |
| `delete_test_reports_before_date` | Delete all test records started before a given date | Cloud Admin |
| `delete_test_reports_by_name` | Find and delete test records matching an exact name or name substring; previews matches before deleting | Cloud Admin |

### Test Views

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_test_views` | List all test view groups | Any |
| `search_test_views` | Search and paginate test view groups | Any |
| `get_test_view` | Get test view configuration detail | Any |
| `get_test_view_summary` | Pass/fail/skip counts for a view | Any |
| `create_test_view` | Create a test view group | Cloud Admin |
| `update_test_view` | Rename or toggle dashboard visibility | Cloud Admin |
| `delete_test_view` | Delete a test view group | Cloud Admin |

### Transactions & Performance

Transactions are performance-instrumented segments of a test session. Developers mark start and end points in their app or test script; the platform records CPU, memory, battery, and network metrics for each interval. These tools support performance regression testing — compare metrics across app versions or identify slow operations.

> Works for all access levels — Cloud Admin sees all projects; project-level keys (Project Admin and Project User) see only their own project's transactions. Server-side filtering is not supported on the transaction API; all filters are applied client-side after fetching.

| Tool | What it does |
|---|---|
| `list_transactions` | List transactions filtered by app, version, transaction name, device OS, date range, duration threshold, or network profile. Sorted newest first. |
| `get_transaction` | Full detail for one transaction, including time-series CPU, memory, battery, and network samples |
| `get_transaction_performance_summary` | Aggregate avg/max/min CPU, memory, battery, duration, and Speed Index grouped by app version, transaction name, device model, device type, or network profile. Sorted worst-first. |
| `get_performance_trend` | Metrics (Speed Index, CPU, memory, duration) bucketed by day/week/month over a configurable lookback window |

### Agents

> Requires Cloud Admin access.

| Tool | What it does |
|---|---|
| `list_agents` | List all host machines / test agents with OS, region, device count, and health status. Filterable by region and OS type. |
| `get_agent_devices` | List devices connected to a specific agent |

### Regions

> Requires Cloud Admin access.

| Tool | What it does |
|---|---|
| `list_regions` | List all geographic regions (US1, UK1, SG1, DE1, AU1, CA1, US2, CH1) with status |
| `get_region_topology` | Full infrastructure map of a region: NV servers, Selenium agents, signers, storages, reporters |

### NV Servers

> Requires Cloud Admin access.

| Tool | What it does |
|---|---|
| `list_nv_servers` | List all Network Virtualization servers with status and tunneling connectivity. Filterable by region. |
| `get_nv_server` | Details for a specific NV server |

### Environment Management

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_environments` | List all named connection profiles — name, URL, auth type. Marks the active profile. Credentials are never exposed. | Any |
| `switch_environment` | Switch to a named profile instantly. Verifies the new connection and reports the connected user. All subsequent tool calls use the new credentials. | Any |

> **403 guidance:** When a tool returns 403, the error message includes the current auth type and — if a Cloud Admin profile is configured — a ready-to-use `switch_environment(...)` call.

### Workflows

Six tools cover POC and general project lifecycle management. See the [Workflow Reference](../README.md#workflow-reference) for full documentation.

| Tool | Purpose | Admin Required? |
|---|---|---|
| `create_poc` | 10-step POC setup: device selection, project creation, user provisioning, app assignment | Cloud Admin |
| `close_poc` | Wind down a POC — removes devices and users; preserves the project and group | Cloud Admin |
| `delete_poc` | Full POC teardown including group and project deletion. Requires `confirmDeletion: true`. | Cloud Admin |
| `setup_project` | Guided project provisioning with optional device allocation, users, and app assignment | Cloud Admin |
| `close_project_resources` | Release project resources (devices, sessions, users) without deleting the project | Cloud Admin |
| `teardown_project` | Full project teardown. Requires `confirmDeletion: true`. | Cloud Admin |

### Boilerplate Generation

| Tool | What it does | Admin Required? |
|---|---|---|
| `get_test_boilerplate` | Generate a complete, pre-configured Appium test script for Android or iOS. See [Boilerplate Generation](../README.md#boilerplate-generation) for full documentation. | Any |
| `get_web_test_boilerplate` | Generate a Selenium WebDriver test script for web browser automation. Browser-neutral by default (reads `BROWSER` env var at runtime — Chrome/Firefox/Edge/Safari without code changes). Pass `targetBrowser` for browser-specific setup (ChromeOptions etc.). Pass `shadowDomSupport: "always"` to include a `shadowQuery()` helper for Web Components. Gate: if `url` is provided, requires a live browser session or `confirmSelectorsVerified: true`. Supports `java-junit5`, `java-testng`, `python`, and `nodejs`. | Any |
| `validate_test_script` | Delivery backstop that scans any test script (generated or hand-written) for unreplaced `<…>` placeholder selectors, CSS placeholder selectors (`#YOUR_SELECTOR`, `.your-class`, etc.), the scaffold fail-guard, placeholder credentials, and known fabricated resource IDs. Returns `isError` with a `fail` verdict when any high-severity pattern is found — a non-functional test cannot be delivered as finished. | Any |

### Remote Debug

| Tool | What it does | Admin Required? |
|---|---|---|
| `get_remote_debug_command` | Generate a ready-to-run `start-rdb.ps1` (Windows) or `start-rdb.sh` (macOS) script that connects a cloud device as a locally attached ADB/USB device. Install the app first — `install_application` fails while a device is reserved via rdb. Also useful for device diagnostics (ping, nslookup, dumpsys) before NV-dependent tests. **Cloud Admin recommended for reliable serial resolution** — a project-level key may produce an internal device ID that rdb rejects. | Any¹ |

> ¹ Callable with any access level, but **Cloud Admin recommended** for reliable device serial resolution. If called with a project-level key and rdb fails with `"validation error / Failed to reserve device"`, switch to your Cloud Admin profile first: `switch_environment("default")` → `get_remote_debug_command` → switch back.

**rdb connects the cloud device as a locally attached ADB/USB device.** Once the tunnel is running, the device is visible to Android Studio, Xcode, Appium MCP, and command-line ADB — without any reconfiguration. This makes rdb useful for two distinct workflows:

**1. Test script development** — discover element selectors before writing code:

```
list_applications(nameContains="MyApp")
# → show the user the found version (buildVersion / releaseVersion) and ask:
#   "Is this the build you want to test, or do you have a newer one?"
# → WAIT for confirmation before continuing
# → if a newer build is needed:
get_application_upload_command(localFilePath, localPlatform)  # generate curl/PowerShell command for the user
# (share the command, wait for the user to confirm upload succeeded, re-run list_applications)

install_application(appId, deviceId)          # install while device is Available
get_remote_debug_command(serialNumber, ...)   # device is now reserved
adb shell am start -n <package>/<activity>    # launch the app
open_mobile_studio(...)                       # OR: use UI Inspector in the browser
adb shell uiautomator dump ...                # OR: dump element hierarchy via ADB
get_test_boilerplate(appId, region, ...)      # generate reusable script with discovered IDs
```

> `install_application` fails while a device is reserved via rdb — install first, then connect.

**2. Device health diagnostics** — verify device state before committing to a test run:

```bash
adb shell ping -c 3 8.8.8.8                  # internet connectivity
adb shell nslookup google.com                # DNS resolution
adb shell dumpsys activity activities | grep topResumedActivity   # foreground activity
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS  # dismiss overlays
```

Network checks are especially important before NV-dependent tests (`startPerformanceTransaction`): a device with broken DNS will crash the app immediately when network throttling activates, producing a misleading `NoSuchElementException`.

> **Android 15 note:** `adb shell uiautomator dump` exits silently on Android 15+ Samsung devices. Use `open_mobile_studio` (the platform's UI Inspector) instead — it requires no local tooling and is unaffected by this OS restriction.

### Mobile Inspection Sessions

22 tools for AI-driven interactive mobile test building. An inspection session opens a live WebDriver connection to a real Android or iOS device (`platform: "ios"`), giving the AI agent full visibility into the current screen state and the ability to interact with elements — all without requiring a local Appium installation.

| Tool | What it does | Admin Required? |
|---|---|---|
| `start_inspection_session` | Reserve a device and open a live WebDriver session. Allocates a real Android device and returns a session handle plus `viewUrl` so the operator can watch the session live in a browser (read-only). Device allocation takes 20–90 s. | No |
| `stop_inspection_session` | Release the device and delete the probe report from the reporter. `keepReport: true` preserves it — the platform-recorded session video is then retrievable via `download_test_attachments`. Always call this when done. | No |
| `take_inspection_screenshot` | Capture a screenshot that the AI can see directly — not base64 text, but an actual image visible to Claude. Use after each interaction to verify UI state. | No |
| `get_element_tree` | Get the full UI hierarchy as a formatted element table. Shows resource-id, content-desc, text, and clickability for all elements on screen. | No |
| `find_elements` | Find elements by strategy (xpath, id, accessibility id, class name) and return their element IDs and attributes for use with tap/type. | No |
| `tap_element` | Tap a UI element by its element ID. | No |
| `type_into_element` | Type text into an input field. | No |
| `clear_element` | Clear an input field before typing new content. | No |
| `swipe_screen` | Swipe/scroll by direction (`up`/`down`/`left`/`right`) or explicit coordinates. Scroll lists, open the app drawer, dismiss overlays. Auto-selects W3C actions or JWP touch per agent. | No |
| `scroll_to_element` | Scroll until an element becomes visible — swipes repeatedly, stops when found or when the screen stops changing (end of content). Returns the element ID ready for tap/type. | No |
| `long_press` | Press-and-hold an element or coordinate — context menus, hold-to-record buttons. | No |
| `double_tap` | Double-tap an element or coordinate — image/map zoom, double-tap actions. | No |
| `drag_and_drop` | Hold at a start point, drag to an end point, release — reorder lists, move sliders. | No |
| `pinch_zoom` | Two-finger zoom in/out on maps and images. **Appium Server sessions only** — the Grid rejects multi-touch. | No |
| `press_key` | Press an Android key: ENTER (submit forms/search), HOME, APP_SWITCH, volume, or any raw keycode. | No |
| `hide_keyboard` | Hide the on-screen keyboard if open — safer than press_back when the keyboard covers an element. | No |
| `launch_app` | Launch an installed app by package + activity — the equivalent of tapping its icon. Get `mainActivity` from `get_application_info` first. | No |
| `press_back` | Press the Android Back button — close dialogs, navigate back. | No |
| `app_control` | App lifecycle: `terminate`, `clear_data` (reset to first launch), `query_state`, `deep_link` (jump straight to a screen). Grid limits: query_state is foreground-only, deep_link best-effort. | No |
| `device_control` | Device-level actions: orientation get/set, clipboard get/set, geolocation set/reset, alert accept/dismiss, file push/pull. Grid limits: alerts and reset_geolocation are Appium Server only. | No |
| `list_inspection_sessions` | List all active inspection sessions in the current server process. | No |
| `cleanup_inspection_sessions` | Delete all test reports created by abandoned inspection sessions (scoped to the project each session was created under). Requires `confirmDeletion: true`. | Cloud Admin (reporter delete is CSRF-blocked for project-level keys) |

**Typical workflow:**

```
list_applications(nameContains="MyApp")
# → show the user the found version (buildVersion / releaseVersion) and ask:
#   "Is this the build you want to test, or do you have a newer one?"
# → WAIT for confirmation before continuing
# → if not found or a newer build is needed:
get_application_upload_command(localFilePath, localPlatform)  → curl/PowerShell command for the user to run locally
# (share the command, wait for the user to confirm upload succeeded, re-run list_applications)

list_applications(nameContains="MyApp")             → confirmed appId
get_application_info(appId)                         → packageName + mainActivity
find_available_device(os="Android")                 → healthy device (region preference automatic)
install_application(appId, deviceId)                → BEFORE the session; install fails on reserved devices
start_inspection_session(region="US2")              → handle + viewUrl (share with the operator — watch-only)
launch_app(handle, packageName, mainActivity)       → foreground the app
take_inspection_screenshot(handle="A1B2C3D4")       → AI sees the current screen
get_element_tree(handle="A1B2C3D4")                 → discover element resource-ids
find_elements(handle="A1B2C3D4", strategy="id", selector="com.example:id/login")
scroll_to_element(...)                              → find content below the fold
tap_element / type_into_element / press_key(ENTER) / long_press / swipe_screen / press_back
take_inspection_screenshot(handle="A1B2C3D4")       → verify result
stop_inspection_session(handle="A1B2C3D4")          → release device + delete probe report
get_test_boilerplate(...)                           → generate the test script
```

**Notes:**
- Android and iOS (`platform: "ios"`), on both the legacy Appium Grid (JWP) and Appium Server (W3C/OSS) projects — the session request carries both capability formats and each gesture/launch command auto-detects protocol and platform per session.
- iOS specifics: locate elements by `name`/`label`/`value` (`accessibility id`, `name`, or xpath like `//*[@label='...']`); launch apps by bundle ID (no activity); `press_back` taps the nav-bar back button; clear-app-data and Grid-device clipboard are unavailable.
- Session reports are created in the Digital.ai reporter automatically. `stop_inspection_session` deletes them. If the MCP server restarts before you call stop, run `cleanup_inspection_sessions` to delete orphaned reports.
- The session connects to `{BASE_URL}/wd/hub` — the same Grid endpoint used by all Appium tests.
- `viewUrl` in the start response is a read-only browser URL — share it with the user so they can watch the session live. Do NOT offer or open the debug URL (`/3`) — the device is already reserved by the WebDriver session and a second interactive connection will conflict and error. `cloudViewLink` is the equivalent Mobile Studio link (also watch-only while the session is active).
- The `collaborative_test_creation` prompt packages this entire flow as a guided, narrated workflow.

### Web Inspection Sessions

8 tools for AI-driven interactive browser test building via the Digital.ai Selenium Grid. A browser inspection session opens a live W3C WebDriver connection to a cloud browser (Chrome, Firefox, Edge, or Safari), letting the AI agent navigate pages, extract the rendered DOM (including React/Angular/Vue Shadow DOM), verify element selectors, and generate browser-neutral Selenium test scripts.

**No live view URL.** Unlike mobile sessions, browser sessions have no passive viewer — `take_inspection_screenshot` relays the page state to the user at each step instead.

| Tool | What it does | Admin Required? |
|---|---|---|
| `start_browser_inspection_session` | Open a browser on the Digital.ai Selenium Grid. Prompts for browser choice if `inspectionBrowser` is omitted — always call `list_available_browsers` first. Returns a session handle. | Any |
| `stop_browser_inspection_session` | Close the browser and delete the probe report. `keepReport: true` preserves the session video for retrieval via `download_test_attachments`. Always call when done. | Any |
| `navigate_to` | Navigate to a URL. Waits for `document.readyState === "complete"` (up to 30 s). | Any |
| `get_page_dom` | Extract interactive elements from the rendered DOM. Automatic shadow DOM detection: uses a recursive JS walker (depth ≤ 3) for React/Angular/Vue pages, standard DOM for others. Returns element tags, IDs, data-testid, aria-label, role, text, and shadow subtrees. | Any |
| `browser_action` | Browser navigation: `back`, `forward`, `refresh`, or `get_current_url`. | Any |
| `find_web_elements` | Find elements by CSS selector, XPath, id, name, or link text. CSS is the recommended strategy for web: `"#email"`, `"[data-testid='submit']"`, `"input[name='email']"`. Returns element IDs for use with `tap_element` / `type_into_element`. | Any |
| `list_browser_inspection_sessions` | List all active browser inspection sessions in the current server process. | Any |
| `cleanup_browser_inspection_sessions` | Delete probe reports from abandoned browser sessions. Requires `confirmDeletion: true`. | Cloud Admin |

> **Shared tools** — these mobile-inspection tools also work for browser session handles: `take_inspection_screenshot`, `tap_element`, `type_into_element`, `clear_element`, `scroll_to_element`, `find_elements` (prefer `find_web_elements` for the CSS-oriented description).

**Typical workflow:**

```
list_available_browsers()                            → show options; ask user which browser
start_browser_inspection_session(inspectionBrowser="Chrome")
                                                     → handle (NO live view URL)
navigate_to(handle, "https://our-app.com/login")
take_inspection_screenshot(handle)                   → relay to user: "does this look right?"
get_page_dom(handle)                                 → extract elements (shadow DOM auto-detected)
find_web_elements(handle, "css selector", "#email")  → verify selector returns a result
type_into_element(handle, elementId, "test@example.com")
take_inspection_screenshot(handle)                   → confirm before submitting
tap_element(handle, submitButtonId)
take_inspection_screenshot(handle)                   → confirm redirect
stop_browser_inspection_session(handle)
get_web_test_boilerplate(language="java-junit5", confirmSelectorsVerified=true)
                                                     → browser-neutral Selenium script
```

**Notes:**
- Generated test scripts are browser-neutral by default — `RemoteWebDriver` with `browserName` from a `BROWSER` environment variable. Pass `targetBrowser` to `get_web_test_boilerplate` for browser-specific code (ChromeOptions, FirefoxOptions, etc.).
- Shadow DOM detection is automatic (`shadowMode: "auto"`). When detected, the shadow DOM walker extracts elements from inside Web Components up to 3 levels deep. The generated script includes a `shadowQuery()` helper.
- The `collaborative_web_test_creation` prompt packages this entire flow as a guided, narrated workflow with mandatory screenshot checkpoints.

### Performance Comparison

Four tools for structured performance regression analysis — compare Speed Index, CPU, memory, battery, and duration between two sets of conditions (app versions, device models, OS versions, regions, or network profiles). Works for all access levels — Cloud Admin sees all projects; project-level keys see only their own project's transactions.

> **Speed Index is a composite metric (SI), not wall-clock duration.** It measures the area above the visual-progress curve (lower = content visible sooner). Delta language like "−160 SI" does not mean "160ms faster." The compare tool labels it `SI` throughout and emits `metricSemantics.speedIndex.isCompositeMetric` in structured output.

| Tool | What it does | Admin Required? |
|---|---|---|
| `compare_performance_transactions` | Two-set comparison: trimmed-mean, median, and raw mean per side + delta and % change. MAD outliers excluded by default when a side has ≥4 samples. Pass `comparisonAxis` to embed a confound check. Speed Index is always at `metrics[0]`. | Any |
| `assess_comparison_confounds` | Verdict — **clean / caveated / confounded** — by flagging any dimension other than the declared axis (device model, OS, OS version, network profile, project, transaction name) that varies across or within sides, plus missing telemetry and sample imbalance. | Any |
| `detect_performance_outliers` | Robust median/MAD (Iglewicz–Hoaglin modified z-score, default k=3.5) outlier flagging on a single transaction set. Returns the kept set and recommended exclusions or re-runs. | Any |
| `performance_transaction_control` | Generate fresh transaction samples inside an active inspection session: `start` (activates the NV network profile) → run the flow → `end` (names the record). Records appear in the reporter ~1 min after `end`. An NV server must be ONLINE and tunnel-connected in the device region. | Any |

### Resources & Prompts

**Resources** — ambient context the AI can pull on demand:

| Resource URI | What it provides |
|---|---|
| `digital-ai://farm/status` | Live device farm status: counts by availability, OS, and agent health |
| `digital-ai://reporting/recent-failures` | The 20 most recent failed test executions in the active connection's reporter scope |

**Prompts** — invoked by name in prompt-aware clients (Claude Desktop). Tool-first clients like Claude Code use the equivalent tool directly.

| Prompt | Equivalent Tool | What it does |
|---|---|---|
| `create_poc` | `create_poc` | Guided POC setup — collects parameters upfront, confirms, then executes |
| `investigate_test_failures` | — | Step-by-step failure triage: summary → recent failures → OS/device breakdown |
| `device_farm_health_check` | — | Full farm health: device statuses → agent health → orphaned sessions |
| `prepare_test_run` | — | Pre-run readiness check: devices → app version → provisioning profile validity |
| `collaborative_test_creation` | — | Build a mobile test script together with the operator: live inspection session with shared view URLs, element discovery, interactive verification, final script generation |
| `collaborative_web_test_creation` | — | Build a Selenium web test together with the operator: browser inspection session, screenshot relay checkpoints, Shadow DOM element discovery, verified CSS selector capture, browser-neutral script generation |

