# Example Prompts

Natural language prompts you can use with Claude when this MCP server is connected.

> **Destructive operations** (delete, release, remove) require explicit confirmation.
> Claude will present a safety summary before acting — reply "yes, confirm" or include
> `confirmDeletion: true` in your request to proceed.

> **File uploads from local paths**: the MCP server runs inside Docker. Local file paths
> must be mounted as Docker volumes (e.g. `-v /host/builds:/builds`) and referenced by
> their container path (`/builds/MyApp.ipa`). Use `upload_application_from_url` to avoid
> this — provide a direct-download URL accessible from the server's network instead.

---

## Device Farm Health

- "Show me the overall health of the device farm — how many devices are available, reserved, and offline?"
- "Show me all offline devices and flag any that have been offline for more than 2 hours"
- "What's the status breakdown by agent? Are all agents online?"
- "Check if our iOS devices are ready for testing"
- "Check Android readiness for the test run this afternoon"
- "Show me a summary of the environment"
- "How is the device farm distributed across regions? Which regions have the most availability?"
- "Are there any agents reporting warnings or running low on devices?"

---

## Device Management

- "List all our Android devices"
- "Show me all iPhone 15 devices"
- "Find an available iOS phone running at least version 16"
- "Find an available Android phone from Samsung"
- "Find available devices tagged 'regression_suite'" *(tags are matched client-side)*
- "Get the full details for device 83"
- "Rename device 42 to 'Pixel 7 Pro - Lab A'"
- "Release device 55 — it seems stuck in reserved"
- "Reboot device 12 — it's not responding"
- "Reset the USB connection on device 9 before trying to reboot it"
- "Open a manual web control session for device 23"
- "Open Mobile Studio for any available Android device"
- "Are there any devices stuck in 'In Use' for more than 4 hours? Preview what would be released."
- "Release all orphaned sessions that have been in use for more than 6 hours"

---

## Device Tagging

- "Tag the Pixel 7 as 'regression_suite' and 'stable'"
- "Add the tag 'flaky' to device 45"
- "Remove the 'flaky' tag from device 12345"
- "Remove all tags from device 99"
- "Show me the tags on device 23"

---

## Reservations

- "Show me all current device reservations"
- "What reservations does john_doe have this week?"
- "Reserve device with serial R5CR111SB4X for the next 2 hours starting now"
- "Reserve three devices — UIDs abc, def, ghi — from tomorrow 9am UTC to 5pm UTC"
- "Cancel reservation #3453"
- "Check the schedule for device 83 this week — is there a free slot between 2pm and 4pm?"

---

## Application Management

- "List all our iOS apps in the repository"
- "Show me all versions of the ExperiBank app"
- "Find the latest build of com.mycompany.app for Android"
- "Upload our Android APK from the CI artifact URL — it's at https://ci.internal/builds/latest.apk" *(URL must be accessible from the Digital.ai server's network)*
- "Delete app ID 456 — it's an old test build we no longer need"
- "Update the plugin signing profiles for app 123"
- "Which projects have access to app ID 456?"
- "Assign app 456 to the iOS Regression project so its team can use it"

---

## App Installation

- "Install the latest build of com.mycompany.app on all available Android devices"
- "Install app 456 on device 23"
- "Install IPA 789 on devices 11, 22, and 33 — keep existing app data"
- "Uninstall our app from all devices using the package name com.mycompany.app"
- "Uninstall app 456 from device 23"
- "Remove the app with bundle ID com.mycompany.myapp from devices 5, 6, and 7"
- "Install the app on every device in the 'QA Pool' device group"

---

## File Repository

- "What files do we have in the repository for the QA project?"
- "Download file ID 456 to /tmp/testdata.json"
- "Update the file with ID 456 with a new version from /tmp/new-testdata.json"
- "Delete file ID 789 from the repository"
- "Show me the details for file ID 123"

---

## Project & User Administration

- "List all projects"
- "Create a new project called 'iOS Regression'"
- "Show me all users in the QA project"
- "Add user 42 to the iOS Regression project as a ProjectAdmin"
- "Remove user 17 from the Default project"
- "Create a new user account: username 'jsmith', name 'Jane Smith', email jane@company.com, role User"
- "Delete the user account with ID 99"
- "Set the maximum concurrent browser sessions for project 5 to 10"
- "Show me the full admin settings for the Default project — license limits, cleanup policies, reservation rules"
- "What cleanup operations run after each session ends in project 2?"
- "What are the per-type license limits for the Default project — how many Grid, Manual, and Development licenses are configured?"
- "Does project 2 auto-delete old app builds? How many days does it retain them?"
- "How many users and applications are in the Default project?"

---

## iOS and Provisioning Profiles

- "List all our iOS provisioning profiles"
- "Check whether any of our iOS provisioning profiles expire in the next 30 days"
- "Show me the details for provisioning profile with UUID abc-123"
- "Upload the new P12 and mobileprovision files for our enterprise distribution profile"
- "Delete the expired provisioning profile with UUID xyz-456"
- "Download provisioning profile abc-123 to /tmp/profiles/"

---

## Selenium / Browser Testing

- "What browser/OS combinations are available for Selenium testing?"
- "Start a Chrome session on Windows 10"
- "Open a Firefox browser session on the latest available macOS"
- "Create a manual browser test called 'Login Flow' with 3 steps"

---

## Infrastructure & Platform Health

- "List all test agents and flag any that are offline or reporting warnings"
- "What regions are online? Show me the status of each region."
- "Give me the full infrastructure topology of the US1 region — what NV servers, Selenium agents, and reporters are running?"
- "Show me the status of all NV servers — which ones have active tunneling connections?"
- "Who has active browser sessions right now? Show me by user and project."
- "How close are we to the license limits? Show current usage vs purchased capacity."
- "Which projects are consuming the most test artifact storage? Who's near their quota?"

---

## Backup

- "Trigger a backup of the Digital.ai server"
- "Create a backup but skip the app files to make it faster"

---

## iOS App Inspection

- "Download the app container for bundle ID com.mycompany.app from device 23 and save it to /tmp/container.zip"
- "Extract the language files from app ID 456 to /tmp/lang-files.zip"
- "Get the CA certificates installed on Android device 83"
- "Create a manual test session with 3 steps for iOS and give me the report ID"

---

## Environment & Connection Management

- "Which environments are configured? Show me the profile names and URLs."
- "Switch to the staging environment"
- "Switch back to the default connection"
- "I'm getting 403 errors — which profile has Cloud Admin access?"
- "Connect to the QA project key so I can run tests without full admin access"
- "What key type am I currently connected with — is it a JWT or a project API key?"

---

## Pre-Test Environment Setup

- "Check that the MCP server can reach the Digital.ai API"
- "Am I connected to an Appium Grid or an OSS Appium server?"
- "Get the appCapabilityString for our latest Android build — I need to paste it into a CI pipeline"
- "Check iOS provisioning profiles before running the test suite — are any expired or expiring this month?"
- "Is there a free Android device available in the US2 region right now? I need at least iOS 16 and Android 13."
- "Prepare the device environment before our regression run: clear any orphaned sessions, then show me how many devices are available"
- "We need 5 Android phones and 3 iPhones for tonight's regression. Are there enough available?"

---

## Test Boilerplate Generation

Before generating boilerplate, always find an available device first so the correct OS version is used:

- "Find an available Android phone, then generate a Java JUnit5 test boilerplate"
- "Find an available iPhone, then generate an iOS Python test script for app ID 123"
- "Look up app ID 456, find an available Android phone, then generate a Java TestNG test"
- "Find an available Android device and generate a NodeJS WebDriverIO test for app package com.mycompany.app"
- "Generate a Java JUnit5 boilerplate scoped as a Gradle submodule so I can add it to our existing Android Studio project"
- "Generate a standalone Maven test for our iOS app, bundle ID com.mycompany.iosapp"
- "Generate a TestNG test for the Android app with package com.mycompany.android and main activity .MainActivity"
- "Generate test scripts for our app in all 4 supported languages — JUnit5, TestNG, NodeJS, and Python — so the team can use whichever framework they prefer"
- "Generate both an Android and an iOS test script for app IDs 456 (Android) and 789 (iOS) using Java JUnit5"

---

## Execution Pipelines

*In Claude Code (with file system and shell access), the agent can run the full loop: generate → write to disk → execute → retrieve results.*

- "Find an available Android device, generate a JUnit5 test for app ID 456, write it to disk, run it, and show me whether it passed" *(Claude Code)*
- "Generate a Python test for our iOS app, save it to /tmp/test_login.py, run pytest, then get the result from the reporter" *(Claude Code)*
- "Run our NodeJS regression script against the latest app build on an available Android 14 device and show me the results" *(Claude Code)*
- "Generate a test script for the 'Checkout' flow, run it on an available iPhone 15, and show me the step-level failure detail"
- "The 'Login' test failed last night — find the device it failed on, generate a matching test script, run it again to confirm whether it's fixed" *(Claude Code)*
- "I just ended a manual test session — its report_api_id is abc-123-xyz. Show me the results."

---

## Regression Workflows & Release Sign-Off

- "Did all tests in the QA project pass today? I need a go/no-go for the release."
- "Show me everything that failed in the last 24 hours in the iOS Regression project"
- "Our release criterion is 95% pass rate on the latest app version. Are we there?"
- "Identify the failing tests from last night's run, find available devices matching their failure configurations, and generate test scripts for each"
- "Compare pass rates for app versions 10553 and 10554 — did we regress?"
- "Is the 'Checkout' test stable enough to include in the release gate? Show me its last 20 runs."
- "Are there any tests that only fail on one OS? Flag anything with more than a 25-point pass rate gap between Android and iOS."
- "Run a periodic health check on our test suite: check for platform-specific failures, execution volume trends, and any tests failing 5+ times in a row"

---

## Functional Test Analytics

- "Show me the last 20 failed tests sorted by most recent"
- "Did the last run of 'Login Flow' pass or fail?"
- "Get the full report for test ID 377918, including step detail"
- "Show me the report for the session I just ended — report_api_id is abc-123"
- "List all tests that ran today for the QA project"
- "How many tests passed vs failed this week?"
- "Show the pass/fail breakdown by OS — are Android and iOS failing at different rates?"
- "Show the pass/fail breakdown for each app version in the test history"
- "Which device models have the most failures?"
- "What distinct device OS values appear in our test reports?"
- "Show me all tests that took more than 30 seconds"
- "Does test ID 377918 have any attachments?"
- "Download the attachments for test UUID abc-456 and save them to /tmp/test-artifacts.zip"
- "Delete all test reports older than 90 days"
- "Get a test summary for the QA project — what are the most commonly failing tests?"
- "What tests are running right now?"

---

## Test Stability Analytics

- "Show me the last 25 runs of the 'Login Flow' test — is it stable or flaky?"
- "Is 'Checkout' passing consistently, or has it been flipping back and forth?"
- "Show me the pass rate and trend for the 'Payment Processing' test over the last 20 runs"
- "Are there any tests that fail on Android but pass on iOS? Flag anything with more than a 20-point pass rate gap."
- "Which tests behave differently on one platform vs. the other?"
- "What is the distribution of test statuses — how many Error, Failed, Incomplete, and Skipped results do we have?"

---

## Execution Trend Analytics

- "Show me test execution volume and pass rate by day for the last 30 days — are we running fewer tests than last week?"
- "Give me a weekly execution trend for the last 90 days"
- "Did test volume drop off last week? Show me the daily counts."
- "Show me how pass rates have changed day over day for the past two weeks in the QA project"

---

## Coverage Analytics

- "Which OS versions and device models in our inventory have never appeared in a test run?"
- "Do we have any iOS devices in the farm that have no test history at all?"
- "Show me the device coverage summary — which manufacturers and models have we actually tested against?"
- "How are devices distributed across regions? How many are available vs offline in each?"
- "Which app versions have been covered in testing?"

---

## Performance Testing Analytics

> *Performance transaction analytics require Cloud Admin JWT. If you receive a 401 error, switch to a Cloud Admin access key.*

- "Show me all performance transactions for ExperiBank app version 10553 on iOS"
- "Which transactions take more than 5 seconds on average?"
- "How does CPU usage compare across different ExperiBank app versions?"
- "Does the Speed Index differ between iPhone and iPad for our latest app version?"
- "Which device models show the worst Speed Index for app version 10553?"
- "How does network profile affect our app's performance? Compare WiFi vs 3G vs LTE."
- "Show me the CPU and memory time-series for transaction ID 748 — was there a spike?"
- "Which transaction is slowest across all our performance runs? Rank by average Speed Index."
- "Show me how our app's Speed Index has changed week by week over the last 3 months"
- "Show a monthly performance trend for the ExperiBank app — CPU, memory, and duration"
- "Which transactions are consuming the most upload/download bandwidth?"
- "Our Speed Index target is 2 seconds. Flag any device models where app version 10553 exceeds that on iOS."
- "Did the latest release introduce a CPU regression? Compare version 10553 vs 10554 on Android."
- "Check if any transaction in the latest release takes more than 5 seconds — we need this for release sign-off."

---

## Test Views

- "List all our test view groups"
- "Search for test views related to 'regression'"
- "Show me the configuration for test view ID 5"
- "What's the current pass/fail/skip count for test view 5?"
- "Create a test view called 'Nightly Regression' grouped by device.os"
- "Show the nightly regression view in the dashboard"
- "Delete test view ID 12 — we don't need it anymore"

---

## Project Lifecycle

- "Create a simple project record called 'Mobile QA 2026' with the memo 'Owned by the QA team — contact jane@company.com'"
- "Set up a full project environment for 'Mobile QA 2026' — 4 Android phones in US2, 2 users: jane@co.com (ProjectAdmin) and bob@co.com (User)"
- "Set up a project called 'Regression Suite' and isolate the devices so they're exclusively available in this project"
- "Wind down the Mobile QA 2026 project — return devices to Default and remove user access, but keep the project record"
- "Fully tear down the Mobile QA 2026 project — remove all resources and delete the project"

---

## POC Lifecycle

- "Set up a new POC for Acme Corp — we need 6 devices in the US2 region, 3 iOS and 3 Android, running through August 31st. Users are alice@acme.com (ProjectAdmin) and bob@acme.com (User). Salesforce URL is https://acme.salesforce.com/opp/001."
- "What is the status of the Acme Corp POC? Is it set up correctly?"
- "Wind down the Acme Corp POC — remove the device tags and return devices to the Default pool, but keep the project"
- "Fully tear down the Acme Corp POC — remove devices, delete the project and device group"
