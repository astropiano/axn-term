package dev.axnterm.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NsdPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
