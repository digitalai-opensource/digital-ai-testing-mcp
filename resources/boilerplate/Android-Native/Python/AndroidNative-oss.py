import unittest
from appium import webdriver
from appium.options.common.base import AppiumOptions
from selenium.webdriver.common.by import By


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
        self.driver = webdriver.Remote("[Enter Instance here]/wd/hub", options=options)
        self.driver.implicitly_wait(10)

    def testQuickStartAndroidNativeDemo(self):
        # [BEGIN_DEMO_STEPS]
        self.driver.find_element(By.ID, "com.experitest.ExperiBank:id/usernameTextField").send_keys('company')
        self.driver.find_element(By.ID, "com.experitest.ExperiBank:id/passwordTextField").send_keys('company')
        self.driver.find_element(By.ID, "com.experitest.ExperiBank:id/loginButton").click()
        self.driver.find_element(By.ID, "com.experitest.ExperiBank:id/makePaymentButton").click()
        self.driver.find_element(By.ID, "com.experitest.ExperiBank:id/phoneTextField").send_keys('1234567')
        self.driver.find_element(By.ID, "com.experitest.ExperiBank:id/nameTextField").send_keys('Jon Snow')
        self.driver.find_element(By.ID, "com.experitest.ExperiBank:id/amountTextField").send_keys('50')
        self.driver.find_element(By.XPATH, "//*[@resource-id='com.experitest.ExperiBank:id/countryButton']").click()
        self.driver.find_element(By.XPATH, "//*[@text='Switzerland']").click()
        self.driver.find_element(By.ID, "com.experitest.ExperiBank:id/sendPaymentButton").click()
        self.driver.find_element(By.ID, "android:id/button1").click()
        # [END_DEMO_STEPS]

    def tearDown(self):
        print('Report URL: ' + self.driver.capabilities.get('digitalai:reportUrl', 'n/a'))
        self.driver.quit()


if __name__ == '__main__':
    unittest.main()
