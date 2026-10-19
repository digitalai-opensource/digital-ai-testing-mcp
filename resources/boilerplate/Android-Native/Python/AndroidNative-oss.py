import unittest
from appium import webdriver
from appium.options.common.base import AppiumOptions
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


class LocalAndroidTest(unittest.TestCase):
    testName = '[Enter Test Name here]'
    accessKey = "[Enter Your Access key here]"
    driver = None

    def setUp(self):
        options = AppiumOptions()
        options.set_capability('digitalai:testName', self.testName)
        options.set_capability('digitalai:accessKey', self.accessKey)
        options.set_capability('app', 'cloud:com.experitest.ExperiBank/.LoginActivity')
        options.set_capability('appPackage', 'com.experitest.ExperiBank')
        options.set_capability('appActivity', '.LoginActivity')
        options.set_capability('platformName', 'android')
        options.set_capability('digitalai:deviceQuery', "@os='android' and @category='[Enter PHONE/TABLET here]'")
        options.set_capability('autoDismissAlerts', True)
        options.set_capability('autoGrantPermissions', True)
        self.driver = webdriver.Remote("[Enter Instance here]/wd/hub", options=options)
        # System-level overlays (charging dialog, USB prompt) are NOT caught by autoDismissAlerts.
        # If they block tests: self.driver.execute_script("mobile: shell", {"command": "am", "args": ["broadcast", "-a", "android.intent.action.CLOSE_SYSTEM_DIALOGS"]})

    def find(self, by, locator, timeout=20):
        # Explicit wait: polls until the element is visible, then returns it. Used instead of an implicit wait — never
        # mix the two (every miss then waits implicit + explicit, and the real timeout becomes unpredictable).
        return WebDriverWait(self.driver, timeout).until(EC.visibility_of_element_located((by, locator)))

    def testQuickStartAndroidNativeDemo(self):
        # [BEGIN_DEMO_STEPS]
        self.find(By.ID, "com.experitest.ExperiBank:id/usernameTextField").send_keys('company')
        self.find(By.ID, "com.experitest.ExperiBank:id/passwordTextField").send_keys('company')
        self.find(By.ID, "com.experitest.ExperiBank:id/loginButton").click()
        self.find(By.ID, "com.experitest.ExperiBank:id/makePaymentButton").click()
        self.find(By.ID, "com.experitest.ExperiBank:id/phoneTextField").send_keys('1234567')
        self.find(By.ID, "com.experitest.ExperiBank:id/nameTextField").send_keys('Jon Snow')
        self.find(By.ID, "com.experitest.ExperiBank:id/amountTextField").send_keys('50')
        self.find(By.ID, "com.experitest.ExperiBank:id/countryButton").click()
        self.find(By.XPATH, "//*[@text='Switzerland']").click()
        self.find(By.ID, "com.experitest.ExperiBank:id/sendPaymentButton").click()
        self.find(By.ID, "android:id/button1").click()
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
