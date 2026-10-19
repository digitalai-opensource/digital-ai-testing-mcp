import unittest
from appium import webdriver
from appium.options.common.base import AppiumOptions
from selenium.webdriver.common.by import By
from appium.webdriver.common.appiumby import AppiumBy
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


class LocalIosTest(unittest.TestCase):
    testName = '[Enter TestName here]'
    accessKey = "[Enter Your Access key here]"
    driver = None

    def setUp(self):
        options = AppiumOptions()
        options.set_capability('digitalai:testName', self.testName)
        options.set_capability('digitalai:accessKey', self.accessKey)
        options.set_capability('app', 'cloud:com.experitest.ExperiBank')
        options.set_capability('bundleId', 'com.experitest.ExperiBank')
        options.set_capability('platformName', 'ios')
        options.set_capability('digitalai:deviceQuery', "@os='ios' and @category='[Enter PHONE/TABLET here]'")
        self.driver = webdriver.Remote("[Enter Instance here]/wd/hub", options=options)

    def find(self, by, locator, timeout=20):
        # Explicit wait: polls until the element is visible, then returns it. Used instead of an implicit wait — never
        # mix the two (every miss then waits implicit + explicit, and the real timeout becomes unpredictable).
        return WebDriverWait(self.driver, timeout).until(EC.visibility_of_element_located((by, locator)))

    def testQuickStartIosNativeDemo(self):
        # [BEGIN_DEMO_STEPS]
        self.find(AppiumBy.ACCESSIBILITY_ID, 'usernameTextField').send_keys('company')
        self.find(AppiumBy.ACCESSIBILITY_ID, 'passwordTextField').send_keys('company')
        self.find(AppiumBy.ACCESSIBILITY_ID, 'loginButton').click()
        self.find(AppiumBy.ACCESSIBILITY_ID, 'makePaymentButton').click()
        self.find(AppiumBy.ACCESSIBILITY_ID, 'phoneTextField').send_keys('1234567')
        self.find(AppiumBy.ACCESSIBILITY_ID, 'nameTextField').send_keys('Jon Snow')
        self.find(AppiumBy.ACCESSIBILITY_ID, 'amountTextField').send_keys('50')
        self.find(AppiumBy.ACCESSIBILITY_ID, 'countryButton').click()
        self.find(AppiumBy.ACCESSIBILITY_ID, 'Switzerland').click()
        self.find(AppiumBy.ACCESSIBILITY_ID, 'sendPaymentButton').click()
        self.find(AppiumBy.ACCESSIBILITY_ID, 'Yes').click()
        # [END_DEMO_STEPS]

    def tearDown(self):
        # Guarded: when setUp fails the driver is None (or the session is already dead) and an unguarded quit() would
        # replace the real error with its own. quit() always runs so a half-created session releases its device.
        if self.driver is None:
            return
        try:
            print('Report URL: ' + str(self.driver.capabilities.get('digitalai:reportUrl', 'n/a')))
        except Exception:
            pass
        try:
            self.driver.quit()
        finally:
            self.driver = None


if __name__ == '__main__':
    unittest.main()
