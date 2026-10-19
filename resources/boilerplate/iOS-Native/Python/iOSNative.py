# NOTE: This project uses Appium Grid — a legacy Experitest proprietary framework
# that predates the W3C WebDriver standard. It is NOT standard Appium Server.
# The JWP session format, _elem() wrapper, and pinned dependency versions below
# are required by Appium Grid's protocol and are NOT needed for Appium Server projects.
# If you can migrate this project to Appium Server, that removes all of these workarounds.

import unittest
from appium import webdriver
from selenium.webdriver.common.by import By
from appium.webdriver.common.appiumby import AppiumBy
from appium.webdriver.webelement import WebElement
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


class LocalIosTest(unittest.TestCase):
    testName = '[Enter TestName here]'
    accessKey = "[Enter Your Access key here]"
    driver = None

    def setUp(self):
        desired_caps = {
            'platformName': 'ios',
            'digitalai:testName': self.testName,
            'digitalai:accessKey': self.accessKey,
            'app': 'cloud:com.experitest.ExperiBank',
            'bundleId': 'com.experitest.ExperiBank',
            'digitalai:deviceQuery': "@os='ios' and @category='[Enter PHONE/TABLET here]'",
        }
        self.driver = webdriver.Remote("[Enter Instance here]/wd/hub", desired_capabilities=desired_caps)

    def _elem(self, raw):
        # JWP sessions return element dicts rather than WebElement objects.
        # Wrap into Appium WebElement so .click(), .send_keys(), .is_displayed() etc. work.
        if isinstance(raw, dict):
            eid = raw.get('ELEMENT') or raw.get('element-6066-11e4-a52e-4f735466cecf')
            return WebElement(self.driver, eid)
        return raw

    def _wait(self, by, locator, timeout=20):
        # Explicit wait (presence, not visibility: a JWP session returns a raw dict that has no is_displayed()).
        # Used instead of an implicit wait — never mix the two.
        return self._elem(WebDriverWait(self.driver, timeout).until(EC.presence_of_element_located((by, locator))))

    def _find(self, accessibility_id):
        # accessibility id == the element's name attribute on iOS (identifier, else label); the Grid accepts it too.
        return self._wait(AppiumBy.ACCESSIBILITY_ID, accessibility_id)

    def _find_xpath(self, xpath):
        return self._wait(By.XPATH, xpath)

    def testQuickStartIosNativeDemo(self):
        # [BEGIN_DEMO_STEPS]
        self._find("usernameTextField").send_keys('company')
        self._find("passwordTextField").send_keys('company')
        self._find("loginButton").click()
        self._find("makePaymentButton").click()
        self._find("phoneTextField").send_keys('1234567')
        self._find("nameTextField").send_keys('Jon Snow')
        self._find("amountTextField").send_keys('50')
        self._find("countryButton").click()
        self._find("Switzerland").click()
        self._find("sendPaymentButton").click()
        self._find("Yes").click()
        # [END_DEMO_STEPS]

    def tearDown(self):
        # Guarded: when setUp fails the driver is None (or the session is already dead) and an unguarded quit() would
        # replace the real error with its own. quit() always runs so a half-created session releases its device.
        if self.driver is None:
            return
        try:
            print('Report URL: ' + str(self.driver.desired_capabilities.get('digitalai:reportUrl', 'n/a')))
        except Exception:
            pass
        try:
            self.driver.quit()
        finally:
            self.driver = None


if __name__ == '__main__':
    unittest.main()
