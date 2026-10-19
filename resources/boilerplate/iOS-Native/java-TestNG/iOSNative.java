import io.appium.java_client.ios.IOSDriver;
import io.appium.java_client.ios.IOSElement;
import io.appium.java_client.remote.IOSMobileCapabilityType;
import io.appium.java_client.remote.MobileCapabilityType;
import org.testng.annotations.*;
import io.appium.java_client.MobileBy;
import org.openqa.selenium.By;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;
import org.openqa.selenium.ScreenOrientation;
import org.openqa.selenium.remote.DesiredCapabilities;

import java.net.MalformedURLException;
import java.net.URL;

public class LocaliOSTest {

    protected IOSDriver<IOSElement> driver = null;
    DesiredCapabilities dc = new DesiredCapabilities();
    private String accessKey = "[Enter Your Access key here]";

    @BeforeMethod
    public void setUp() throws MalformedURLException {
        dc.setCapability("digitalai:testName", "[Enter Test Name here]");
        dc.setCapability("digitalai:accessKey", accessKey);
        dc.setCapability("digitalai:deviceQuery", "@os='ios' and @category='[Enter PHONE/TABLET here]'");
        dc.setCapability(MobileCapabilityType.APP, "cloud:com.experitest.ExperiBank");
        dc.setCapability(IOSMobileCapabilityType.BUNDLE_ID, "com.experitest.ExperiBank");
        // "Detected dialect: OSS" at startup is expected — the platform uses the legacy JSON Wire Protocol.
        driver = new IOSDriver<>(new URL("[Enter Instance here]/wd/hub"), dc);
    }

    // Explicit wait (presence; 20 s) used instead of an implicit wait — never mix the two. Selenium 3 signature:
    // java-client 7.x (required by the Appium Grid) pulls Selenium 3.141, whose WebDriverWait takes seconds as a long.
    private WebElement find(By by) {
        return new WebDriverWait(driver, 20).until(ExpectedConditions.presenceOfElementLocated(by));
    }

    @Test
    public void quickStartiOSNativeDemo() {
        // [BEGIN_DEMO_STEPS]
        driver.rotate(ScreenOrientation.PORTRAIT);
        find(MobileBy.AccessibilityId("usernameTextField")).sendKeys("company");
        find(MobileBy.AccessibilityId("passwordTextField")).sendKeys("company");
        find(MobileBy.AccessibilityId("loginButton")).click();
        find(MobileBy.AccessibilityId("makePaymentButton")).click();
        find(MobileBy.AccessibilityId("phoneTextField")).sendKeys("0501234567");
        find(MobileBy.AccessibilityId("nameTextField")).sendKeys("John Snow");
        find(MobileBy.AccessibilityId("amountTextField")).sendKeys("50");
        find(MobileBy.AccessibilityId("countryButton")).click();
        find(MobileBy.AccessibilityId("Switzerland")).click();
        find(MobileBy.AccessibilityId("sendPaymentButton")).click();
        find(MobileBy.AccessibilityId("Yes")).click();
        // [END_DEMO_STEPS]
    }

    @AfterMethod
    public void tearDown() {
        if (driver == null) return;
        try {
            System.out.println("Report URL: " + driver.getCapabilities().getCapability("digitalai:reportUrl"));
            System.out.println("Report Test ID: " + driver.getCapabilities().getCapability("digitalai:reportTestId"));
        } catch (Exception ignored) {}
        try {
            driver.quit();
        } catch (Exception ignored) {}
    }
}
