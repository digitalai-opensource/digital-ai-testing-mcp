import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.android.AndroidElement;
import io.appium.java_client.remote.AndroidMobileCapabilityType;
import io.appium.java_client.remote.MobileCapabilityType;
import org.testng.annotations.*;
import org.openqa.selenium.By;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;
import org.openqa.selenium.ScreenOrientation;
import org.openqa.selenium.remote.DesiredCapabilities;

import java.net.MalformedURLException;
import java.net.URL;

public class LocalAndroidTest {

    protected AndroidDriver<AndroidElement> driver = null;
    DesiredCapabilities dc = new DesiredCapabilities();
    private String accessKey = "[Enter Your Access key here]";

    @BeforeMethod
    public void setUp() throws MalformedURLException {
        dc.setCapability("digitalai:testName", "[Enter Test Name here]");
        dc.setCapability("digitalai:accessKey", accessKey);
        dc.setCapability("digitalai:deviceQuery", "@os='android' and @category='[Enter PHONE/TABLET here]'");
        dc.setCapability(MobileCapabilityType.APP, "cloud:com.experitest.ExperiBank/.LoginActivity");
        dc.setCapability(AndroidMobileCapabilityType.APP_PACKAGE, "com.experitest.ExperiBank");
        dc.setCapability(AndroidMobileCapabilityType.APP_ACTIVITY, ".LoginActivity");
        dc.setCapability("autoDismissAlerts", true);
        dc.setCapability("autoGrantPermissions", true);
        // System-level overlays (charging dialog, USB prompt) are outside the app hierarchy and are
        // NOT caught by autoDismissAlerts. If they block tests, call after driver init:
        //   java.util.Map<String,Object> _args = new java.util.HashMap<>();
        //   _args.put("command", "am");
        //   _args.put("args", java.util.Arrays.asList("broadcast","-a","android.intent.action.CLOSE_SYSTEM_DIALOGS"));
        //   driver.executeScript("mobile: shell", _args);
        // "Detected dialect: OSS" at startup is expected — the platform uses the legacy JSON Wire Protocol.
        driver = new AndroidDriver<>(new URL("[Enter Instance here]/wd/hub"), dc);
    }

    // Explicit wait (presence; 20 s) used instead of an implicit wait — never mix the two. Selenium 3 signature:
    // java-client 7.x (required by the Appium Grid) pulls Selenium 3.141, whose WebDriverWait takes seconds as a long.
    private WebElement find(By by) {
        return new WebDriverWait(driver, 20).until(ExpectedConditions.presenceOfElementLocated(by));
    }

    @Test
    public void quickStartAndroidNativeDemo() {
        // [BEGIN_DEMO_STEPS]
        driver.rotate(ScreenOrientation.PORTRAIT);
        find(By.id("com.experitest.ExperiBank:id/usernameTextField")).sendKeys("company");
        find(By.id("com.experitest.ExperiBank:id/passwordTextField")).sendKeys("company");
        find(By.id("com.experitest.ExperiBank:id/loginButton")).click();
        find(By.id("com.experitest.ExperiBank:id/makePaymentButton")).click();
        find(By.id("com.experitest.ExperiBank:id/phoneTextField")).sendKeys("0501234567");
        find(By.id("com.experitest.ExperiBank:id/nameTextField")).sendKeys("John Snow");
        find(By.id("com.experitest.ExperiBank:id/amountTextField")).sendKeys("50");
        find(By.id("com.experitest.ExperiBank:id/countryTextField")).sendKeys("'Switzerland'");
        find(By.id("com.experitest.ExperiBank:id/sendPaymentButton")).click();
        find(By.id("android:id/button1")).click();
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
