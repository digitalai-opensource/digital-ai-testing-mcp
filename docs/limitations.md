# Known Limitations

## 1. Appium Test Execution

There is no REST API to trigger Appium test execution directly. Tests are launched from Appium clients (Appium Desktop, IDE plugins, CI scripts). This MCP server can manage devices, apps, and reservations that support test runs — but cannot initiate an Appium session itself.

## 2. Remote Debug Session Initiation

The "debug" web control mode (`start_device_web_control` with `mode: 'debug'`) requires the Digital.ai Grid to be running as the same user who called the API. This constraint is enforced by the platform and cannot be worked around through the API.

## 3. Shared Devices Not Supported by Device APIs

Devices designated as "shared" in Digital.ai may not be fully managed through the standard device APIs. Shared device behavior and availability depend on platform configuration.

## 4. Reporter API: Date Filter CSRF Restriction

The Digital.ai reporter API routes certain filter properties through CSRF-protected middleware. The following are blocked for all callers (both JWT and API key): `start_time`, `create_time`, `uuid`. For date-range filtering, use the `startDate`/`endDate` parameters on `list_test_reports` — these fetch records sorted by `start_time` descending and apply the date comparison client-side.

Confirmed working filter properties: `status`, `name` (with `contains`), `has_attachment`, `success` (boolean), `test_id`, `project_id`, `device.os` (case-sensitive), `duration`, `attachment_count`, `attachments_size`, `status_code`. Sort by any field (including `start_time`) works fine — the block is filter-only.

## 5. Region Management

Listing and inspecting regions is available via the v2 API (`list_regions`, `get_region_topology`) — Cloud Admin JWT only. However, **creating, editing, or deleting regions** is not exposed via the public REST API; region configuration is done through the Digital.ai web UI.

## 6. License Management

License **limits** are readable via `get_license_info` and current usage vs. limits via `get_license_utilization` — Cloud Admin JWT only. License **purchasing, upgrading, or modifying entitlements** is not available through the API; those operations require contacting Digital.ai.

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
