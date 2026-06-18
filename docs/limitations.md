# Known Limitations

## 1. Appium Test Execution

There is no REST API to trigger Appium test execution directly. Tests are launched from Appium clients (Appium Desktop, IDE plugins, CI scripts). This MCP server can manage devices, apps, and reservations that support test runs — but cannot initiate an Appium session itself.

## 2. Remote Debug Session Initiation

The "debug" web control mode (`start_device_web_control` with `mode: 'debug'`) requires the Digital.ai Grid to be running as the same user who called the API. This constraint is enforced by the platform and cannot be worked around through the API.

## 3. Shared Devices Not Supported by Device APIs

Devices designated as "shared" in Digital.ai may not be fully managed through the standard device APIs. Shared device behavior and availability depend on platform configuration.

## 4. Reporter API: Date Filter CSRF Restriction

The Digital.ai reporter API routes certain filter properties through CSRF-protected middleware. The following are blocked for all callers (Cloud Admin, Project Admin, and Project User): `start_time`, `create_time`, `uuid`. For date-range filtering, use the `startDate`/`endDate` parameters on `list_test_reports` — these fetch records server-sorted (Cloud Admin) or via full scan (project-level keys) and apply the date comparison client-side.

Confirmed working filter properties: `status`, `name` (with `contains`), `has_attachment`, `success` (boolean), `test_id`, `project_id`, `device.os` (case-sensitive), `duration`, `attachment_count`, `attachments_size`, `status_code`.

**Sort** works for Cloud Admin only — ALL sort fields are CSRF-blocked for project-level keys (Project Admin and Project User). Tools that need newest-first results (`find_latest_test_for_name`, `get_test_stability_report`, `get_project_test_summary`, `list_active_test_executions`) compensate automatically under a project-level key by scanning all records and sorting client-side — correct results, but slower on large report sets.

## 5. Region Management

Listing and inspecting regions is available via the v2 API (`list_regions`, `get_region_topology`) — Cloud Admin only. However, **creating, editing, or deleting regions** is not exposed via the public REST API; region configuration is done through the Digital.ai web UI.

## 6. License Management

License **limits** are readable via `get_license_info` and current usage vs. limits via `get_license_utilization` — Cloud Admin only. License **purchasing, upgrading, or modifying entitlements** is not available through the API; those operations require contacting Digital.ai.

## 7. Device Reboot and Cleanup Limitations for Non-Admin Users

`reboot_device` and `reset_device_usb` are Cloud Admin-only operations. Regular users and Project Admins cannot trigger hardware-level device operations.

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

The Digital.ai Continuous Testing platform does not expose a REST endpoint for capturing a device screenshot outside of a live WebDriver session. All device screenshot paths (`/api/v1/devices/{id}/screenshot`, `/api/v2/devices/{id}/screenshot`, and variants) return HTTP 404. This has been confirmed by live probe against the production API.

To observe a device screen, the AI agent must hold a live WebDriver session: `start_inspection_session` + `take_inspection_screenshot` provide exactly this (Android and iOS — see the [Inspection Sessions](tools.md#inspection-sessions) reference). Without a session, screen observation requires the Mobile Studio browser UI (developer-facing only) or Android Studio Layout Inspector via an rdb connection. Test attachments (screenshots captured during a test run) are available after the session ends via `download_test_attachments`.

## 13. `get_remote_debug_command` Requires Cloud Admin for Reliable Serial Resolution

When the active `DIGITAL_AI_ACCESS_KEY` is a **project-level key** (Project Admin or Project User), the device serial lookup API may return an internal numeric ID rather than the actual device UDID. The generated `adb connect` command in the output script will use that internal ID, which the ADB server cannot resolve — the connection will fail silently or immediately disconnect.

Use a **Cloud Admin** profile when running `get_remote_debug_command` to ensure the device serial is resolved to the real UDID. The tool includes an `authWarning` field in its structured response when a project-level key is detected, flagging this condition before the script is written to disk.

## 14. Android 15+ Samsung Devices: UIAutomator Dump Silently Fails

On Android 15 (and some Android 13 Samsung devices, e.g. Galaxy S20 Ultra), `adb shell uiautomator dump` exits without output and produces no XML file. This is an OS-level restriction on UiAutomation introduced in later Android versions and is not specific to the Digital.ai platform.

On affected devices, use `open_mobile_studio` instead of the uiautomator dump path to inspect UI elements. The Mobile Studio browser session viewer is not subject to this restriction. Android Studio Layout Inspector (via Tools → Layout Inspector) is also unaffected. If neither option is available, APK inspection via `aapt dump xmltree` and `aapt dump resources` can extract static resource IDs from the installed APK.
