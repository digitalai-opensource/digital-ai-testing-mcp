import io.appium.java_client.AppiumBy;
import io.appium.java_client.AppiumDriver;
import org.openqa.selenium.By;

public class DashboardScreen extends BaseScreen {
    private final By makePaymentButton = platform(By.id("com.experitest.ExperiBank:id/makePaymentButton"), AppiumBy.accessibilityId("makePaymentButton"));

    public DashboardScreen(AppiumDriver driver) {
        super(driver);
    }

    public PaymentScreen makePayment() {
        tap(makePaymentButton);
        return new PaymentScreen(driver);
    }
}
