import io.appium.java_client.AppiumBy;
import io.appium.java_client.AppiumDriver;
import org.openqa.selenium.By;

public class PaymentScreen extends BaseScreen {
    private final By phone = platform(By.id("com.experitest.ExperiBank:id/phoneTextField"), AppiumBy.accessibilityId("phoneTextField"));
    private final By name = platform(By.id("com.experitest.ExperiBank:id/nameTextField"), AppiumBy.accessibilityId("nameTextField"));
    private final By amount = platform(By.id("com.experitest.ExperiBank:id/amountTextField"), AppiumBy.accessibilityId("amountTextField"));
    private final By countryButton = platform(By.id("com.experitest.ExperiBank:id/countryButton"), AppiumBy.accessibilityId("countryButton"));
    private final By sendPaymentButton = platform(By.id("com.experitest.ExperiBank:id/sendPaymentButton"), AppiumBy.accessibilityId("sendPaymentButton"));
    // The confirmation is a system dialog on Android (android:id/button1) and a named button on iOS.
    private final By confirmYes = platform(By.id("android:id/button1"), AppiumBy.accessibilityId("Yes"));

    public PaymentScreen(AppiumDriver driver) {
        super(driver);
    }

    public PaymentScreen fillPayment(String phoneNumber, String payee, String amountValue, String country) {
        type(phone, phoneNumber);
        type(name, payee);
        type(amount, amountValue);
        tap(countryButton);
        // Country list entry: visible text on Android, accessibility id (= label) on iOS.
        tap(platform(By.xpath("//*[@text='" + country + "']"), AppiumBy.accessibilityId(country)));
        return this;
    }

    public void sendAndConfirm() {
        tap(sendPaymentButton);
        tap(confirmYes);
    }
}
