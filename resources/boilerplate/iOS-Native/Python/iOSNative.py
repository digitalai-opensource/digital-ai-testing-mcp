# NOTE: This project uses Appium Grid — a legacy Experitest proprietary framework
# that predates the W3C WebDriver standard. It is NOT standard Appium Server.
# The JWP session format, _elem() wrapper, and pinned dependency versions below
# are required by Appium Grid's protocol and are NOT needed for Appium Server projects.
# If you can migrate this project to Appium Server, that removes all of these workarounds.

import unittest
from appium import webdriver
from selenium.webdriver.common.by import By
from appium.webdriver.webelement import WebElement


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
        self.driver.implicitly_wait(10)

    def _elem(self, raw):
        # JWP sessions return element dicts rather than WebElement objects.
        # Wrap into Appium WebElement so .click(), .send_keys(), .is_displayed() etc. work.
        if isinstance(raw, dict):
            eid = raw.get('ELEMENT') or raw.get('element-6066-11e4-a52e-4f735466cecf')
            return WebElement(self.driver, eid)
        return raw

    def _find_xpath(self, xpath):
        return self._elem(self.driver.find_element(By.XPATH, xpath))

    def testQuickStartIosNativeDemo(self):
        # [BEGIN_DEMO_STEPS]
        self._find_xpath("//*[@name='usernameTextField']").send_keys('company')
        self._find_xpath("//*[@name='passwordTextField']").send_keys('company')
        self._find_xpath("//*[@name='loginButton']").click()
        self._find_xpath("//*[@name='makePaymentButton']").click()
        self._find_xpath("//*[@name='phoneTextField']").send_keys('1234567')
        self._find_xpath("//*[@name='nameTextField']").send_keys('Jon Snow')
        self._find_xpath("//*[@name='amountTextField']").send_keys('50')
        self._find_xpath("//*[@name='countryButton']").click()
        self._find_xpath("//*[@name='Switzerland']").click()
        self._find_xpath("//*[@name='sendPaymentButton']").click()
        self._find_xpath("//*[@name='Yes']").click()
        # [END_DEMO_STEPS]

    def tearDown(self):
        print('Report URL: ' + str(self.driver.desired_capabilities.get('digitalai:reportUrl', 'n/a')))
        self.driver.quit()


if __name__ == '__main__':
    unittest.main()
