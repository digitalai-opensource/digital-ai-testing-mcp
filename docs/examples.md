# Example Prompts

Plain-language requests you can give your AI assistant once this MCP server is connected, grouped by task in the same order as the [README](../README.md#what-you-can-do): the lab, apps, live exploration, creating and running tests, results and reports, then projects and administration. Notes in *italics* say what happens behind the prompt; you never need to type a tool name.

> **Changes ask first.** Deletes, releases and removals show a summary before anything happens; reply "yes, confirm" to go ahead. Public report links (`share_test_report`) and very large usage exports work the same way, and need your agreement, never the assistant's own decision.

> **Local files.** With the [npm install](../README.md#option-a--install-via-npm-recommended), local paths just work. Under Docker the server runs in a container: mount the folder (`-v /host/builds:/builds`) and use the container path, upload from a URL the server can reach, or ask for the upload or download command and run it on your own machine.

## Contents

- [Devices and the Lab](#devices-and-the-lab)
  - [Device Farm Health](#device-farm-health)
  - [Device Management](#device-management)
  - [Device Tagging](#device-tagging)
  - [Device Groups](#device-groups)
  - [Reservations](#reservations)
  - [Before a Test Run](#before-a-test-run)
- [Apps and Files](#apps-and-files)
  - [Application Management](#application-management)
  - [App Installation](#app-installation)
  - [File Repository](#file-repository)
  - [iOS Provisioning Profiles and App Data](#ios-provisioning-profiles-and-app-data)
- [Explore Apps and Browsers Live](#explore-apps-and-browsers-live)
  - [Interactive Inspection (AI-Driven Test Building)](#interactive-inspection-ai-driven-test-building)
  - [Android Auto / CarPlay](#android-auto--carplay)
  - [Web Browser Inspection (AI-Driven Browser Test Building)](#web-browser-inspection-ai-driven-browser-test-building)
  - [Remote Debug (a Cloud Device on Your Machine)](#remote-debug-a-cloud-device-on-your-machine)
  - [Manual and Selenium Sessions](#manual-and-selenium-sessions)
- [Creating Tests](#creating-tests)
  - [Test Boilerplate Generation](#test-boilerplate-generation)
  - [Generate, Run and Check](#generate-run-and-check)
- [Running Tests](#running-tests)
  - [Test Runs (Espresso, XCUITest, Maestro)](#test-runs-espresso-xcuitest-maestro)
- [Results, Reports and Analysis](#results-reports-and-analysis)
  - [Ready-Made Reports](#ready-made-reports)
  - [Release Sign-Off](#release-sign-off)
  - [Functional Test Analytics](#functional-test-analytics)
  - [Root Cause Analysis (Why Tests Are Failing)](#root-cause-analysis-why-tests-are-failing)
  - [Test Stability Analytics](#test-stability-analytics)
  - [Execution Trend Analytics](#execution-trend-analytics)
  - [Coverage Analytics](#coverage-analytics)
  - [Test Views](#test-views)
- [Performance](#performance)
  - [Performance Testing Analytics](#performance-testing-analytics)
- [Usage and Licenses](#usage-and-licenses)
  - [Usage Reports (Platform Administration & FinOps)](#usage-reports-platform-administration--finops)
- [Projects and Users](#projects-and-users)
  - [Project Lifecycle](#project-lifecycle)
  - [Project Settings and Users](#project-settings-and-users)
- [Administration](#administration)
  - [Infrastructure & Platform Health](#infrastructure--platform-health)
  - [Backup](#backup)
  - [Connections and Environments](#connections-and-environments)

---

## Devices and the Lab

### Device Farm Health

- "Show me the overall health of the device farm: how many devices are available, reserved and offline?"
- "Show me all offline devices and flag any that have been offline for more than 2 hours"
- "What's the status breakdown by agent? Are all agents online?"
- "How is the farm spread across regions? Which regions have the most free devices?"
- "Check that our iOS devices are ready for testing"
- "Which devices failed far more tests than the rest in the last 24 hours? Is it the device or the tests?" *(find_unhealthy_devices: fail ratio per device, the share of infrastructure errors, top causes, and tests that fail only on that device)*
- "Tag the devices that look unhealthy as 'dirty', but show me the list first" *(tags only after you confirm; Cloud Admin or Project Admin)*

For a finished, shareable version, ask for a [device health report](#ready-made-reports).

### Device Management

- "List all our Android devices"
- "Find an available iOS phone running at least version 16"
- "Find an available Samsung Android phone"
- "Find available devices tagged 'regression_suite'"
- "Find an available phone with an audio line" *(needed for audio playback and recording)*
- "Which emulator and simulator templates can we start?" *(list_virtual_device_templates: idle templates are not devices, so a device list never shows them)*
- "Get the full details for device 83"
- "Which CA certificates are installed on device 83?"
- "Rename device 42 to 'Pixel 7 Pro - Lab A'"
- "Reboot device 12, it's not responding"
- "Reset the USB connection on device 9 before trying a reboot"
- "Release device 55, it seems stuck in reserved"
- "Are any devices stuck in 'In Use' for more than 4 hours? Show me what would be released."
- "Open Mobile Studio for any available Android device"
- "Open a manual web control session for device 23"

### Device Tagging

- "Tag the Pixel 7 as 'regression_suite' and 'stable'"
- "Show me the tags on device 23"
- "Remove the 'flaky' tag from device 12"
- "Remove all tags from device 99"

*Tags take letters, digits and underscores only.*

### Device Groups

- "List all device groups and their device counts"
- "What devices are in the 'QA Pool' group?"
- "Which projects can use the 'QA Pool' group?"
- "Create a device group called 'Nightly Regression' that doesn't auto-accept new devices"
- "Move device 12 from the Default group to 'QA Pool'"
- "Give the Payments project access to the 'QA Pool' group"
- "Delete the 'Old Pilot' device group; the devices should stay in the farm"

### Reservations

- "Show me all current device reservations"
- "What reservations does jsmith have this week?"
- "Reserve the device with serial R5CR111SB4X for the next 2 hours"
- "Reserve devices abc, def and ghi tomorrow from 9am to 5pm UTC"
- "Is device 83 free between 2pm and 4pm on Thursday?"
- "Cancel reservation 3453"

### Before a Test Run

- "Is there a free Android 13+ phone and an iOS 16+ iPhone in US2 right now?"
- "We need 5 Android phones and 3 iPhones for tonight's regression. Are there enough free?"
- "Clear any orphaned sessions, then tell me how many devices are available"
- "Is this project on Appium Grid or Appium Server?"
- "Get the app capability string for our latest Android build; I need it for the CI pipeline"

[↑ Back to top](#example-prompts)

---

## Apps and Files

### Application Management

- "List all our iOS apps in the repository"
- "Show me every version of the Payments app"
- "Find the latest Android build of com.example.app"
- "Upload our Android build from https://ci.example.com/builds/latest.apk" *(the URL must be reachable from the Digital.ai server's network)*
- "Which projects can use app 456? Assign it to the Payments project."
- "Update the plugin signing profiles for app 123"
- "Extract the language files from app 456"
- "Delete app 456, it's an old test build"

### App Installation

- "Install the latest build of com.example.app on all available Android devices"
- "Install app 456 on device 23"
- "Install app 789 on devices 11, 22 and 33 and keep the existing app data"
- "Install the app on every device in the 'QA Pool' group"
- "Uninstall com.example.app from all devices"
- "Uninstall app 456 from device 23"

### File Repository

- "What files do we have in the repository for the Payments project?"
- "Show me the details for file 123"
- "Download file 456 to /tmp/testdata.json"
- "Replace file 456 with /tmp/new-testdata.json"
- "Delete file 789 from the repository"

### iOS Provisioning Profiles and App Data

- "List our iOS provisioning profiles. Do any expire in the next 30 days?"
- "Show me the details for provisioning profile abc-123"
- "Upload the new P12 and mobileprovision files for our enterprise profile"
- "Download provisioning profile abc-123 to /tmp/profiles/"
- "Delete the expired provisioning profile xyz-456"
- "Download the app container for com.example.app from device 23 to /tmp/container.zip"

[↑ Back to top](#example-prompts)

---

## Explore Apps and Browsers Live

### Interactive Inspection (AI-Driven Test Building)

*The assistant drives a real device over a live session: it sees the screen, finds element IDs, taps and types, then turns what it learned into a test. No local Appium needed. Works on Android and iOS, on Appium Grid and Appium Server projects; Grid projects support fewer commands.*

**Start and look around**
- "Start an inspection session on an available Android phone in US2 and show me what's on screen"
- "Start a session and give me the live view link so I can watch"
- "Start an iOS session on an iPhone, launch our app by bundle ID and map the login screen's elements"
- "Start an inspection session on an Android emulator" *(emulators can take a few minutes to start)*
- "What screen is the app on? What are the IDs of the username and password fields?"
- "Find every button on this screen" *(details come back for the first 20 matches; narrow the selector to see more)*

**Interact**
- "Open the demo app and log in with username 'company' and password 'company'"
- "Tap the login button and check that the next screen shows the balance"
- "Scroll until 'About phone' is visible and give me its element ID"
- "Swipe left on the first item to reveal the delete button"
- "Long-press the first message to open its menu"
- "Type the search term and press Enter"
- "Hide the keyboard and go back one screen"
- "On the iPhone, go into Settings, then General, and come back with the back button"
- "Rotate to landscape and take a screenshot"
- "Which buttons does this alert have? Press 'Allow Once'"
- "This screen is a web view. Switch into it and find the submit button with a CSS selector" *(Appium Server projects)*

**Control the app and device**
- "Clear the app's data so we can test first-launch onboarding" *(Android; on iOS, reinstall instead)*
- "Open the deep link example://orders/42 and check it lands on the order screen"
- "Send the app to the background for five seconds and check it resumes on the same screen"
- "Install build 2.3 from the repository without ending the session" *(Appium Server)*
- "Set the location to Mountain View and check the store finder"
- "Turn wifi off, try the sync screen, then turn it back on" *(Android)*
- "Put the device on a 3G profile while I browse the catalogue" *(needs an online, tunneled NV server in the region)*
- "Inject this cheque image so the deposit screen's camera returns it" *(the app must be an instrumented build)*
- "Make the fingerprint check succeed, then make it fail" *(mock authentication; instrumented builds)*
- "Play greeting.wav from the repository into the phone, then record what the app says back" *(needs a device with an audio line; Appium Server)*
- "What device is this, what's its battery, and is it in dark mode?"
- "Switch the phone to dark mode and screenshot the login screen"
- "Run an accessibility audit on this iOS screen"

**Logs and evidence**
- "Show me the last 50 log lines mentioning our package, the app just crashed" *(logcat on Android, syslog on iOS)*
- "Record the device log while I reproduce the bug, then give me the file"
- "Stop the session but keep the report; I want the video for the bug ticket"

**Turn it into a test**
- "I want to create a test together. Walk me through it step by step and share the device view" *(the `collaborative_test_creation` prompt)*
- "Explore the payment flow, note every element ID you used, then generate a Python test that replays it"
- "Log in, tap Transfer, pick account 43x, enter $50.00, tap Transfer Now. Make that a test." *(step-level detail: the assistant builds it on its own and checks the selectors in a session)*
- "I want a test for our app" *(vague: the assistant starts the interactive flow or asks how you want to work)*

**Clean up**
- "What inspection sessions are still open? Stop them all."
- "Clean up leftover inspection reports from sessions that didn't shut down cleanly" *(Cloud Admin, or a project that allows its users to delete reports; see [Limitations](limitations.md#16-deleting-test-reports-depends-on-a-per-project-setting))*

### Android Auto / CarPlay

*The phone's apps shown on a car head unit. Appium Server projects only.*

- "Show me what our app looks like on Android Auto"
- "Start an inspection session with Android Auto at 1280x720 and screenshot the head unit" *(the device must be on a host that supports projection; if the start fails, the error says why)*
- "Tap Exit on the head unit and show me the result"
- "Turn projection on for this session, take a head-unit screenshot, then turn it off" *(works mid-session on recent Pixels; otherwise start a new session with projection)*
- "Generate a JUnit5 test that runs with Android Auto and captures the head unit"
- "Open an Android Automotive OS emulator and show me its screen" *(the head unit is the device itself)*

### Web Browser Inspection (AI-Driven Browser Test Building)

*The assistant drives a real cloud browser: it opens pages, reads the DOM, interacts, then turns what it learned into a Selenium test. No local browser driver needed.*

- "Which browsers can I use? Start a Chrome session in US2 and open https://app.example.com"
- "Open our staging site in Firefox; it has a self-signed certificate" *(acceptInsecureCerts)*
- "Open the site in Chrome on an Android phone" *(or Safari on an iPhone)*
- "What are the IDs and data-testid attributes on the login form?"
- "Does this page use Shadow DOM? List the interactive elements."
- "Type 'test@example.com' into the email field and press submit"
- "Go to the checkout page and take a screenshot"
- "Show me the console errors and failed requests on this page" *(Chrome, Edge, Firefox and Opera)*
- "Go back, refresh, and check I'm still logged in"
- "I want to create a browser test together. Walk me through the login flow." *(the `collaborative_web_test_creation` prompt)*
- "Generate a Java JUnit5 Selenium test from what we just found"
- "Generate a browser-neutral Python test that runs on Chrome, Firefox and Safari"
- "Generate a Robot Framework web test for the login flow" *(Opera is not supported)*
- "Generate a Playwright test for this flow"
- "Stop the browser session but keep the report; I want the video"
- "What browser sessions are still open? Stop them all and clean up their reports."

### Remote Debug (a Cloud Device on Your Machine)

*Makes a cloud device appear as if it were plugged into your machine (ADB for Android, usbmuxd for iOS), so Android Studio, Xcode and `adb` can use it.*

- "Give me the remote debug script for device R5CR111SB4X; I want to use Android Studio's Layout Inspector"
- "Install app 456 on a Samsung phone in US2, then give me the remote debug script" *(install first: it fails while the device is connected this way)*
- "Remote debug says 'Failed to reserve device'. Switch to the Cloud Admin profile, make the script again, then switch back" *(ask for "Cloud Admin" rather than a profile name; the assistant picks by detected access level)*

### Manual and Selenium Sessions

- "What browser and OS combinations are available?"
- "Start a Chrome session on Windows 11"
- "Open Firefox on the latest macOS"
- "Start an Edge session on Windows 10"
- "Create a manual browser test called 'Login Flow' with 3 steps"
- "Create a manual iOS test with 3 steps and give me the report ID"

[↑ Back to top](#example-prompts)

---

## Creating Tests

### Test Boilerplate Generation

*Find a device first so the test targets the right OS version. For your own app, the assistant needs real element IDs, from an inspection session or from app source in your workspace; without one it returns no runnable code. A request without an app gives a working test for the built-in demo app (ExperiBank). Generated tests read the access key from the `DIGITAL_AI_ACCESS_KEY` environment variable and never contain it.*

- "Find an available Android phone, then generate a Java JUnit5 test for the demo app"
- "Find an available iPhone, then generate a Python test for app 123"
- "Generate a Node.js WebdriverIO test for com.example.app on Android"
- "Generate a TestNG test for com.example.android with main activity .MainActivity"
- "Generate a standalone Maven test for our iOS app, bundle ID com.example.iosapp"
- "Generate a JUnit5 test as a Gradle submodule so I can add it to our Android Studio project"
- "Generate an Android and an iOS version of the test, apps 456 and 789, in JUnit5"
- "Generate the test in all five languages: JUnit5, TestNG, Node.js, Python and Robot Framework" *(Robot Framework needs an Appium Server project)*
- "Generate the Android test as page objects, one class per screen" *(Java on Appium Server, or Node.js)*
- "Generate a test that tags each run with our build number, so I can find those runs later" *(custom report columns you can filter and group on)*
- "Generate a test for an Android emulator from one of our templates"
- "Generate a Python test for app 456 that records CPU and memory as performance transactions"
- "Generate a JUnit5 test with an Axe accessibility scan" *(needs an Axe DevTools key in the server's environment)*
- "How do I set the access key for this test on my machine and in CI?"
- "How do I run these tests in parallel across devices?"
- "Check this test before I commit it" *(validate_test_script flags placeholder selectors, fixed sleeps and other problems)*
- "Generate a test where one phone calls another" *(no template for calls or SMS; the assistant points you to the reference project https://github.com/dai-continuous-testing/UseCase-SIM-Card-Tests)*

### Generate, Run and Check

*With an assistant that can write files and run commands, it can do the whole loop: generate, save, run, then read the result from the Reporter. For your own app it captures selectors first and checks the script before running it.*

- "Find an available Android device, generate a JUnit5 test for app 456, run it and tell me whether it passed"
- "Generate a Python test for our iOS app, save it to tests/test_login.py, run pytest, then show me the report"
- "Run our Node.js regression script against the latest build on an Android 14 device"
- "Generate a Checkout test from the selectors we captured, run it on an iPhone 15, and tell me why it failed"
- "The Login test failed last night. Find the device it failed on, run it again there and tell me whether it's fixed"

[↑ Back to top](#example-prompts)

---

## Running Tests

### Test Runs (Espresso, XCUITest, Maestro)

*The platform runs these suites itself, with no local driver. Results land in the Reporter tagged with the run ID. Playwright runs are below.*

- "Run my Maestro flows from C:/flows/bundle.zip against the demo Android app on one phone" *(the zip must contain a `flows/` folder; Maestro is Android only)*
- "We just walked through the login in the inspection session. Turn it into a Maestro flow and run it on two Android phones"
- "Run our Espresso test APK against app 456 on three Android phones in US2 and retry failures once"
- "Run our Espresso suite that drives the Settings app; it uses UiAutomator"
- "Run the XCUITest suite at https://ci.example.com/tests.zip on one device of every iPhone model we have" *(XCUITest runs use the same API but have not been verified end to end)*
- "What's the status of test run 27971406? Wait for it to finish."
- "The run finished. Show me the failing tests and their videos."
- "Cancel test run 27971406"
- "I'm running the MCP in Docker. Give me the command to start the Maestro run from my laptop."

**Playwright** *(the platform runs the whole project in Microsoft's Playwright image; needs a Cross Browser license)*
- "Run the Playwright project in ./e2e on the cloud"
- "Run our Playwright tests on Chromium and WebKit with image version 1.49.0"
- "What's the status of that Playwright run? Save its logs to ./playwright-logs.zip."

[↑ Back to top](#example-prompts)

---

## Results, Reports and Analysis

### Ready-Made Reports

*One request returns a finished, branded report you can read or share. Say "report" when you want one; a quick question still gets a quick answer. Every report, its options and who can run it are in [docs/reports.md](reports.md).*

Each report and what it contains is listed in [Ready-made reports](reports.md#ready-made-reports); the example links below open a report built from made-up data.

- "Give me a test summary report for the last 7 days for project Payments" → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-summary.html)
- "How has our pass rate moved this year? Make a test trend report." → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-trend.html)
- "Show test results by platform for the last 30 days" → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-breakdown.html)
- "Break down this month's results by framework and browser" → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-breakdown.html)
- "Which tests are unreliable? Which ones started failing this week?" → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-reliability.html)
- "Are we ready to release build 412? Use a 95% goal." → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/release-readiness.html)
- "Why are tests failing this week? Make a failure analysis report." → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/failure-analysis.html)
- "How many test reports do we have, by project and user?" → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-inventory.html)
- "Show me a device health report" → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/device-health.html)
- "Which devices and OS versions do our tests cover?" → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/device-coverage.html)
- "How much of our device lab is actually used? Which devices are never reserved?" *(Cloud Admin)* → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/device-utilization.html)
- "Are we near our license limit? Use the last 30 days." *(Cloud Admin)* → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/license-usage.html)
- "Create a usage summary for project Payments for the last 90 days", or "...for all projects" *(Cloud Admin)* → examples: [one project](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/usage-summary.html), [every project](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/usage-overview.html)
- "Create a performance overview report" → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/performance-overview.html)
- "Compare Transfer money performance in 4.2.0 and 4.3.0 on the Pixel 8" → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/performance-comparison.html)
- "List the applications in the repository", then "Show that as a report by platform" *(any data can become a report)* → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/any-data.html)
- "Reword the platform section to say the iOS drop is from the login change"

### Release Sign-Off

- "Did all tests in the Payments project pass today? I need a go/no-go."
- "Show me everything that failed in the last 24 hours"
- "Our release bar is a 95% pass rate on the latest app version. Are we there?"
- "Compare pass rates for app versions 10553 and 10554. Did we regress?"
- "Is the Checkout test stable enough for the release gate? Show me its last 20 runs."
- "Take last night's failing tests, find free devices that match where they failed, and generate a test for each"
- "Run a health check on our test suite: platform-specific failures, volume trend, and tests failing 5+ times in a row"

### Functional Test Analytics

*A Cloud Admin can name any project, as it appears in the project list; a project key sees its own project.*

**Find runs**
- "Show me the last 20 failed tests"
- "Did the last run of 'Login Flow' pass?"
- "List all tests that ran today in the Payments project"
- "Show me all tests that took more than 30 seconds"
- "Show me all runs from build 4.2.1" *(works when your tests add a `build` column)*
- "What tests are running right now?"
- "Here's a report link, https://<your-cloud>/reporter/video-report/<uuid>. What failed?"
- "Show me the report for the session I just ended; its report_api_id is abc-123"

**Counts and breakdowns**
- "How many tests passed and failed this week? What's our pass rate?" *(pass rate counts Passed and Healed against Passed, Healed, Failed and Error)*
- "How many runs this week by platform and framework, Appium Server tests only?" *(plain words such as platform, framework and browser work; letter case is ignored)*
- "Which device models have the most failures?"
- "Show the pass/fail split for each app version"
- "How many runs ended in Error versus Failed this month?" *(Error means the test ended abnormally: a crash, an infrastructure problem, a session that ended early)*
- "Do tests on shared devices fail more often than on dedicated ones?"
- "Which runs this week included an Axe accessibility scan?"
- "What OS values appear in our test reports?"

**Attachments and sharing**
- "Does test 377918 have attachments? Download them to /tmp/test-artifacts.zip."
- "Give me a link to the latest health_check report for someone without a Digital.ai account. Show me what would be exposed first." *(a public link opens the report, its data and video without login for 14 days and can be revoked only by deleting the report)*

**Cleaning up**
- "Delete all test reports older than 90 days"
- "Delete the reports whose name contains '[Smoke Test]' in the Payments project; show me the list before confirming"

### Root Cause Analysis (Why Tests Are Failing)

*The usual path: find the failures, classify them in one call, read one test's cause and stack trace, search its log, then pull the video if needed. If failures cluster on a few devices, the assistant checks whether the device is the problem.*

- "Why are my tests failing? Give me a breakdown by error type."
- "Summarize this week's failures in the Payments project. What's the main cause?"
- "Of this week's failures, how many are element-not-found and how many are timeouts?"
- "Group this week's failures by test name. Which test fails most?"
- "Test 69 failed. What was the cause and the error category?"
- "Search the Appium log of the failed Login test for 'NoSuchElement' and show me the lines around it"
- "Get the device log for the failed Login test"
- "Has the platform's AI analysed why Checkout failed? Show me its hypothesis and evidence." *(read-only; analyses are started from the video report, Appium Server tests only)*
- "Which reports already have a completed root cause analysis?"
- "Download just the session video for the failed Checkout run"
- "How big is that video? Download only the last 2 MB so I can see how the session ended."
- "I'm running the MCP in Docker. Give me a command to download test 69's video and logs to my Mac."

### Test Stability Analytics

- "Show me the last 25 runs of 'Login Flow'. Is it stable?"
- "Is Checkout passing consistently, or flipping back and forth?"
- "Are there tests that fail on Android but pass on iOS? Flag anything with more than a 20-point gap."
- "Checkout keeps failing. Does it fail only on one device?"
- "What's the split of statuses: Passed, Healed, Failed, Error, Incomplete and Skipped?"

### Execution Trend Analytics

- "Show daily run counts and pass rate for the last 30 days. Are we running fewer tests than before?"
- "Give me a weekly trend for the last 90 days"
- "How has the pass rate changed day by day over the past two weeks in the Payments project?"

### Coverage Analytics

- "Which OS versions and device models in our lab have never been tested?"
- "Do we have iOS devices with no test history at all?"
- "Which manufacturers and models have we actually tested against?"
- "How is our testing spread across regions?"
- "Which app versions have been tested?"

### Test Views

- "List our test views"
- "Find test views about 'regression'"
- "What's the current pass/fail/skip count for test view 5?"
- "Create a test view called 'Nightly Regression' grouped by device OS"
- "Delete test view 12"

[↑ Back to top](#example-prompts)

---

## Performance

### Performance Testing Analytics

*Works for every access level. A Cloud Admin sees every project's transactions; a Project Admin or Project User sees their own project's. Speed Index is a score where lower is better, not a duration.*

- "Show me all performance transactions for app version 10553 on iOS"
- "Which transaction is slowest? Rank them by Speed Index."
- "Which transactions take more than 5 seconds on average in the latest release?"
- "How does CPU use compare across app versions?"
- "Which device models have the worst Speed Index for version 10553?"
- "How does the network profile affect performance? Compare wifi, 3G and LTE."
- "Show the CPU and memory samples for transaction 748. Was there a spike?"
- "How has our Speed Index changed week by week over the last 3 months?"
- "Which transactions use the most upload and download bandwidth?"
- "Our Speed Index target is 2,000. Flag device models where version 10553 is over it on iOS."
- "Did the latest release bring a CPU regression? Compare 10553 and 10554 on Android." *(the assistant checks for outliers and for differences other than the version before comparing)*
- "Make that a performance comparison report" *(one call: both sides, the change, a verdict and the like-for-like check)* → [example](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/performance-comparison.html)
- "Record fresh login samples on a Pixel 8 for both versions, then compare them" *(the `performance_comparison_report` prompt walks through it)*

[↑ Back to top](#example-prompts)

---

## Usage and Licenses

### Usage Reports (Platform Administration & FinOps)

*Platform usage for capacity, cost and license accounting, not test results. Cloud Admin only. Usage data is kept for 2 years. For a finished report, ask for a [usage summary, device utilization or license usage report](#ready-made-reports); the column reference for each export is in [docs/tools.md](tools.md#usage-reports).*

**Device-hours and chargeback**
- "How many device-hours did the Payments project use last month?"
- "Device-reservation hours for every project for Q2, by project" *(over 31 days with no project filter, the assistant asks before running the large export)*
- "Break down last month's reserved hours by user tag"
- "How many device-hours did jane@example.com use across all projects last month?"
- "Which devices were reserved most last week, and why were reservations released?"

**Idle devices**
- "Which devices were barely used this month in the Payments project?"
- "Show device usage hours for the last 2 weeks; I want candidates to retire"

**Browsers and manual sessions**
- "Which browsers and versions did the Web Portal project use last month?"
- "How many browser sessions did each user run last week, and for how long in total?"
- "How actively is jane@example.com using manual sessions? Show her clicks and screen time this week."

**Licenses**
- "How close are we to our license limits right now?"
- "Which license types are we using, and for how many hours each?"
- "Split last week's license sessions by Android and iOS"
- "Export a full year of License Usage for the annual audit. I know it's large, go ahead." *(License Usage covers every project, so any range over 31 days needs your agreement)*

**Getting the data**
- "Summarize License Usage sessions by user for July 14 to 21; I only need counts" *(summarized on the server, no file written)*
- "Export this week's device reservations for the Payments project as a CSV"
- "Give me the download command for last month's Device Reservations CSV so I can save it on my laptop" *(use this when the MCP runs in Docker)*

[↑ Back to top](#example-prompts)

---

## Projects and Users

### Project Lifecycle

- "Create a project called 'Payments' with the note 'Owned by the payments team'"
- "Set up the Payments project: 4 Android phones in US2, jane@example.com as Project Admin and bob@example.com as Project User"
- "Set up a project called 'Regression Suite' with devices that only this project can use"
- "Wind down the Payments project: return the devices to Default and remove user access, but keep the project"
- "Fully tear down the Payments project and delete it"

**POC variant.** The same steps exist for a time-limited evaluation project, with the end date and opportunity link kept in the project notes. These are mostly used inside Digital.ai.
- "Set up a POC for Example Corp: 6 devices in US2, 3 iOS and 3 Android, until August 31. Users alice@example.com (Project Admin) and bob@example.com (Project User)."
- "Is the Example Corp POC set up correctly?"
- "Wind down the Example Corp POC but keep the project" *(also deletes the user accounts created for it, confirming each one)*
- "Fully tear down the Example Corp POC, including the project and device group"

### Project Settings and Users

- "List all projects"
- "Show me the full settings for the Default project: license limits, cleanup rules and reservation policy"
- "How many Grid, Manual and Development licenses does the Default project have?"
- "What cleanup runs after each session in project 2? Does it delete old app builds?"
- "Set the maximum concurrent browser sessions for project 5 to 10"
- "Raise the automation process memory for project 5 to 768 MB; sessions fail on our large app" *(256 to 1024 MB; Cloud Admin)*
- "Show me all users in the Payments project"
- "Create a user: username 'jsmith', name Jane Smith, email jane@example.com, Project User"
- "Add user 42 to the Payments project as a Project Admin"
- "Remove user 17 from the Default project"
- "Delete user 99"

[↑ Back to top](#example-prompts)

---

## Administration

### Infrastructure & Platform Health

*Cloud Admin.*

- "List all agents and flag any that are offline or reporting warnings"
- "Which regions are online?"
- "Show me the full layout of the US1 region: NV servers, Selenium agents and reporters"
- "Which NV servers have an active tunnel?"
- "Who has browser sessions open right now, by user and project?"
- "Which projects use the most test report storage? Is anyone near their quota?"

### Backup

- "Back up the Digital.ai server"
- "Back up the server but skip the app files to make it faster"

### Connections and Environments

- "Check that the server can reach the Digital.ai API"
- "Which connections are configured, and what access level does each have?"
- "What access level am I using now: Cloud Admin, Project Admin or Project User?"
- "Switch to the staging connection", then "Switch back to the default"
- "I'm getting 403 errors. Which connection has Cloud Admin access?"
- "Switch to the Payments project's key so I'm not working with full admin access"
- "Are all the tools the project workflows depend on available?"
- "Load the performance tools" *(only when the server runs with a reduced tool list, `MCP_TOOLSETS`; other tools also load on first use)*
- "That guidance sent us the wrong way. Record a remediation note." *(only in debug mode; notes go to a `remediation/` folder in your project)*

[↑ Back to top](#example-prompts)
