import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.android.AndroidElement;
import io.appium.java_client.remote.AndroidMobileCapabilityType;
import io.appium.java_client.remote.MobileCapabilityType;
import org.junit.jupiter.api.*;
import org.openqa.selenium.By;
import org.openqa.selenium.ScreenOrientation;
import org.openqa.selenium.remote.DesiredCapabilities;

import java.net.MalformedURLException;
import java.net.URL;

public class LocalAndroidTest {

    protected AndroidDriver<AndroidElement> driver = null;
    DesiredCapabilities dc = new DesiredCapabilities();
    private String accessKey = "[Enter Your Access key here]";

    @BeforeEach
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

    @Test
    public void quickStartAndroidNativeDemo() {
        // [BEGIN_DEMO_STEPS]
        driver.rotate(ScreenOrientation.PORTRAIT);
        driver.findElement(By.id("com.experitest.ExperiBank:id/usernameTextField")).sendKeys("company");
        driver.findElement(By.id("com.experitest.ExperiBank:id/passwordTextField")).sendKeys("company");
        driver.findElement(By.id("com.experitest.ExperiBank:id/loginButton")).click();
        driver.findElement(By.id("com.experitest.ExperiBank:id/makePaymentButton")).click();
        driver.findElement(By.id("com.experitest.ExperiBank:id/phoneTextField")).sendKeys("0501234567");
        driver.findElement(By.id("com.experitest.ExperiBank:id/nameTextField")).sendKeys("John Snow");
        driver.findElement(By.id("com.experitest.ExperiBank:id/amountTextField")).sendKeys("50");
        driver.findElement(By.id("com.experitest.ExperiBank:id/countryTextField")).sendKeys("'Switzerland'");
        driver.findElement(By.id("com.experitest.ExperiBank:id/sendPaymentButton")).click();
        driver.findElement(By.id("android:id/button1")).click();
        // [END_DEMO_STEPS]
    }

    @AfterEach
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
