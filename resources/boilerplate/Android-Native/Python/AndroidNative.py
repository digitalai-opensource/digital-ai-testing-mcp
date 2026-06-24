# NOTE: This project uses Appium Grid — a legacy Experitest proprietary framework
# that predates the W3C WebDriver standard. It is NOT standard Appium Server.
# The JWP session format, _elem() wrapper, and pinned dependency versions below
# are required by Appium Grid's protocol and are NOT needed for Appium Server projects.
# If you can migrate this project to Appium Server, that removes all of these workarounds.

import unittest
from appium import webdriver
from selenium.webdriver.common.by import By
from appium.webdriver.webelement import WebElement


class LocalAndroidTest(unittest.TestCase):
    testName = '[Enter Test Name here]'
    accessKey = "[Enter Your Access key here]"
    driver = None

    def setUp(self):
        desired_caps = {
            'platformName': 'android',
            'digitalai:testName': self.testName,
            'digitalai:accessKey': self.accessKey,
            'app': 'cloud:com.experitest.ExperiBank/.LoginActivity',
            'appPackage': 'com.experitest.ExperiBank',
            'appActivity': '.LoginActivity',
            'digitalai:deviceQuery': "@os='android' and @category='[Enter PHONE/TABLET here]'",
            'autoDismissAlerts': True,
            'autoGrantPermissions': True,
        }
        self.driver = webdriver.Remote("[Enter Instance here]/wd/hub", desired_capabilities=desired_caps)
        self.driver.implicitly_wait(10)
        # System-level overlays (charging dialog, USB prompt) are NOT caught by autoDismissAlerts.
        # If they block tests: self.driver.execute_script("mobile: shell", {"command": "am", "args": ["broadcast", "-a", "android.intent.action.CLOSE_SYSTEM_DIALOGS"]})

    def _elem(self, raw):
        # JWP sessions return element dicts rather than WebElement objects.
        # Wrap into Appium WebElement so .click(), .send_keys(), .is_displayed() etc. work.
        if isinstance(raw, dict):
            eid = raw.get('ELEMENT') or raw.get('element-6066-11e4-a52e-4f735466cecf')
            return WebElement(self.driver, eid)
        return raw

    def _find(self, resource_id):
        return self._elem(self.driver.find_element(By.ID, f"com.experitest.ExperiBank:id/{resource_id}"))

    def _find_xpath(self, xpath):
        return self._elem(self.driver.find_element(By.XPATH, xpath))

    def testQuickStartAndroidNativeDemo(self):
        # [BEGIN_DEMO_STEPS]
        self._find("usernameTextField").send_keys('company')
        self._find("passwordTextField").send_keys('company')
        self._find("loginButton").click()
        self._find("makePaymentButton").click()
        self._find("phoneTextField").send_keys('1234567')
        self._find("nameTextField").send_keys('Jon Snow')
        self._find("amountTextField").send_keys('50')
        self._find("countryTextField").send_keys('Switzerland')
        self._find("sendPaymentButton").click()
        self._find_xpath("//*[@resource-id='android:id/button1']").click()
        # [END_DEMO_STEPS]

    def tearDown(self):
        print('Report URL: ' + str(self.driver.desired_capabilities.get('digitalai:reportUrl', 'n/a')))
        self.driver.quit()


if __name__ == '__main__':
    unittest.main()
