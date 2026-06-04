import unittest
from appium import webdriver
from appium.options.common.base import AppiumOptions
from selenium.webdriver.common.by import By


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
        self.driver.implicitly_wait(10)

    def testQuickStartIosNativeDemo(self):
        # [BEGIN_DEMO_STEPS]
        self.driver.find_element(By.XPATH, "//*[@name='usernameTextField']").send_keys('company')
        self.driver.find_element(By.XPATH, "//*[@name='passwordTextField']").send_keys('company')
        self.driver.find_element(By.XPATH, "//*[@name='loginButton']").click()
        self.driver.find_element(By.XPATH, "//*[@name='makePaymentButton']").click()
        self.driver.find_element(By.XPATH, "//*[@name='phoneTextField']").send_keys('1234567')
        self.driver.find_element(By.XPATH, "//*[@name='nameTextField']").send_keys('Jon Snow')
        self.driver.find_element(By.XPATH, "//*[@name='amountTextField']").send_keys('50')
        self.driver.find_element(By.XPATH, "//*[@name='countryButton']").click()
        self.driver.find_element(By.XPATH, "//*[@name='Switzerland']").click()
        self.driver.find_element(By.XPATH, "//*[@name='sendPaymentButton']").click()
        self.driver.find_element(By.XPATH, "//*[@name='Yes']").click()
        # [END_DEMO_STEPS]

    def tearDown(self):
        print('Report URL: ' + self.driver.capabilities.get('digitalai:reportUrl', 'n/a'))
        self.driver.quit()


if __name__ == '__main__':
    unittest.main()
