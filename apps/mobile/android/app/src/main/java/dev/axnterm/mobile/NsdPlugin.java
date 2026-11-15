package dev.axnterm.mobile;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Finds axn-term desktops announcing {@code _axn-term._tcp} on the local
 * network: browse for the scan window, resolve each hit (one at a time —
 * the legacy resolver rejects concurrent resolves) and return name, host,
 * port and TXT record. The TXT record names the server the desktop
 * publishes to; the host stands in for its {@code .local} name, which
 * Android can't resolve.
 */
@CapacitorPlugin(name = "Nsd")
public class NsdPlugin extends Plugin {

    private static final String SERVICE_TYPE = "_axn-term._tcp";

    @PluginMethod
    public void discover(PluginCall call) {
        long timeoutMs = Math.max(500, Math.min(15000, call.getLong("timeoutMs", 3500L)));
        Context context = getContext();
        NsdManager nsd = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        // Some devices drop multicast replies unless an app holds this lock.
        WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = wifi.createMulticastLock("axn-term-nsd");
        lock.setReferenceCounted(false);
        lock.acquire();

        Scan scan = new Scan(nsd);
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, scan);
        } catch (RuntimeException e) {
            lock.release();
            call.reject("Local network discovery failed: " + e.getMessage());
            return;
        }

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            JSArray services = scan.finish();
            try {
                nsd.stopServiceDiscovery(scan);
            } catch (RuntimeException ignored) {
                // discovery never started — nothing to stop
            }
            lock.release();
            JSObject result = new JSObject();
            result.put("services", services);
            call.resolve(result);
        }, timeoutMs);
    }

    /** One scan: collects hits and resolves them sequentially. */
    private static final class Scan implements NsdManager.DiscoveryListener {
        private final NsdManager nsd;
        private final ArrayDeque<NsdServiceInfo> pending = new ArrayDeque<>();
        private final Set<String> seen = new HashSet<>();
        private final JSArray results = new JSArray();
        private boolean resolving = false;
        private boolean finished = false;

        Scan(NsdManager nsd) {
            this.nsd = nsd;
        }

        synchronized JSArray finish() {
            finished = true;
            return results;
        }

        @Override
        public void onServiceFound(NsdServiceInfo info) {
            synchronized (this) {
                if (finished || !seen.add(info.getServiceName())) return;
                pending.addLast(info);
            }
            resolveNext();
        }

        @SuppressWarnings("deprecation")
        private void resolveNext() {
            NsdServiceInfo next;
            synchronized (this) {
                if (finished || resolving || pending.isEmpty()) return;
                resolving = true;
                next = pending.removeFirst();
            }
            nsd.resolveService(next, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo info, int errorCode) {
                    synchronized (Scan.this) {
                        resolving = false;
                    }
                    resolveNext();
                }

                @Override
                public void onServiceResolved(NsdServiceInfo info) {
                    JSObject txt = new JSObject();
                    for (Map.Entry<String, byte[]> entry : info.getAttributes().entrySet()) {
                        byte[] value = entry.getValue();
                        txt.put(entry.getKey(), value == null ? "" : new String(value, StandardCharsets.UTF_8));
                    }
                    JSObject service = new JSObject();
                    service.put("name", info.getServiceName());
                    if (info.getHost() != null) service.put("host", info.getHost().getHostAddress());
                    if (info.getPort() > 0) service.put("port", info.getPort());
                    service.put("txt", txt);
                    synchronized (Scan.this) {
                        if (!finished) results.put(service);
                        resolving = false;
                    }
                    resolveNext();
                }
            });
        }

        @Override public void onDiscoveryStarted(String serviceType) {}
        @Override public void onDiscoveryStopped(String serviceType) {}
        @Override public void onServiceLost(NsdServiceInfo info) {}
        @Override public void onStartDiscoveryFailed(String serviceType, int errorCode) {}
        @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) {}
    }
}
