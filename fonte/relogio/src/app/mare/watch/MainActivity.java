package app.mare.watch;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;

public class MainActivity extends Activity implements TrackerService.Listener {
    private static final int[] WINDOWS = {10, 20, 30, 45};
    private SharedPreferences sp;
    private int wakeMin, windowMin;
    private TextView tStatus, tTime, tSpan, tFoot, tTrackTitle, tTrackLine, tHr;
    private Button bWin;
    private LinearLayout idle, track;
    private ScrollView scroll;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        @Override public void run() { render(); ui.postDelayed(this, 5000); }
    };

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        sp = getSharedPreferences("mare", MODE_PRIVATE);
        wakeMin = sp.getInt("wake", 6 * 60 + 30);
        windowMin = sp.getInt("win", 30);
        build();
        TrackerService s = TrackerService.I;
        Store.recover(this, null);
        askPermissions();
    }

    @Override protected void onResume() {
        super.onResume();
        TrackerService.LISTENERS.add(this);
        ui.post(refresh);
        openSync();
        scroll.requestFocus();
    }

    @Override protected void onPause() {
        TrackerService.LISTENERS.remove(this);
        ui.removeCallbacks(refresh);
        super.onPause();
    }

    @Override public void onChange() { ui.post(this::render); }

    // ---------------- interface ----------------

    private void build() {
        int w = getResources().getDisplayMetrics().widthPixels;
        scroll = new ScrollView(this);
        scroll.setBackgroundColor(Ui.NIGHT);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setFocusable(true);
        scroll.setFocusableInTouchMode(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding((int) (w * 0.13), (int) (w * 0.12), (int) (w * 0.13), (int) (w * 0.24));
        scroll.addView(root);

        TextView title = Ui.text(this, "Maré", 18, Ui.EMBER, true);
        root.addView(title);
        tStatus = Ui.text(this, "", 11, Ui.MUTED, false);
        root.addView(tStatus, Ui.full(this, 2));

        // ---- ocioso: configurar e começar ----
        idle = new LinearLayout(this);
        idle.setOrientation(LinearLayout.VERTICAL);
        idle.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(idle, Ui.full(this, 10));

        idle.addView(Ui.label(this, "Acordar até"));
        LinearLayout tr = Ui.row(this);
        Button minus = Ui.button(this, "−", false);
        Button plus = Ui.button(this, "+", false);
        tTime = Ui.text(this, "", 38, Ui.INK, false);
        tTime.setFontFeatureSettings("tnum");
        tr.addView(minus, new LinearLayout.LayoutParams(Ui.dp(this, 40), Ui.dp(this, 40)));
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        tr.addView(tTime, tp);
        tr.addView(plus, new LinearLayout.LayoutParams(Ui.dp(this, 40), Ui.dp(this, 40)));
        idle.addView(tr, Ui.full(this, 2));
        repeat(minus, -5);
        repeat(plus, 5);
        tSpan = Ui.text(this, "", 11, Ui.MUTED, false);
        idle.addView(tSpan, Ui.full(this, 2));

        bWin = Ui.button(this, "", false);
        bWin.setOnClickListener(v -> {
            int i = 0;
            for (int k = 0; k < WINDOWS.length; k++) if (WINDOWS[k] == windowMin) i = k;
            windowMin = WINDOWS[(i + 1) % WINDOWS.length];
            sp.edit().putInt("win", windowMin).apply();
            render();
        });
        idle.addView(bWin, Ui.full(this, 8));

        Button night = Ui.button(this, "Começar noite", true);
        night.setOnClickListener(v -> startNight());
        idle.addView(night, Ui.full(this, 8));

        idle.addView(Ui.label(this, "Cochilo"), Ui.full(this, 14));
        LinearLayout nr = Ui.row(this);
        int[] naps = {10, 20, 90};
        for (int i = 0; i < naps.length; i++) {
            final int m = naps[i];
            Button nb = Ui.button(this, m + "′", false);
            nb.setOnClickListener(v -> startNap(m));
            nr.addView(nb, Ui.weight(this, i == 0 ? 0 : 6));
        }
        idle.addView(nr, Ui.full(this, 4));

        tFoot = Ui.text(this, "", 10, Ui.MUTED, false);
        idle.addView(tFoot, Ui.full(this, 12));

        // ---- acompanhando ----
        track = new LinearLayout(this);
        track.setOrientation(LinearLayout.VERTICAL);
        track.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(track, Ui.full(this, 14));
        tTrackTitle = Ui.text(this, "", 22, Ui.INK, false);
        track.addView(tTrackTitle);
        tTrackLine = Ui.text(this, "", 12, Ui.MUTED, false);
        track.addView(tTrackLine, Ui.full(this, 4));
        tHr = Ui.text(this, "", 12, Ui.EMBER, false);
        track.addView(tHr, Ui.full(this, 6));
        Button stop = Ui.button(this, "Segure para encerrar", false);
        stop.setOnLongClickListener(v -> { TrackerService.send(this, TrackerService.A_STOP); return true; });
        stop.setOnClickListener(v -> tTrackLine.setText("Segure o botão para encerrar."));
        track.addView(stop, Ui.full(this, 14));

        setContentView(scroll);
        render();
    }

    private void repeat(Button b, int delta) {
        final Runnable[] r = new Runnable[1];
        r[0] = () -> { step(delta); ui.postDelayed(r[0], 110); };
        b.setOnTouchListener((v, e) -> {
            if (e.getAction() == MotionEvent.ACTION_DOWN) { step(delta); ui.postDelayed(r[0], 450); v.setPressed(true); }
            else if (e.getAction() == MotionEvent.ACTION_UP || e.getAction() == MotionEvent.ACTION_CANCEL) { ui.removeCallbacks(r[0]); v.setPressed(false); }
            return true;
        });
    }

    private void step(int d) {
        wakeMin = ((wakeMin + d) % 1440 + 1440) % 1440;
        sp.edit().putInt("wake", wakeMin).apply();
        render();
    }

    private long nextWake() {
        Calendar k = Calendar.getInstance();
        k.set(Calendar.HOUR_OF_DAY, wakeMin / 60);
        k.set(Calendar.MINUTE, wakeMin % 60);
        k.set(Calendar.SECOND, 0);
        k.set(Calendar.MILLISECOND, 0);
        if (k.getTimeInMillis() <= System.currentTimeMillis() + 10 * 60000L) k.add(Calendar.DAY_OF_MONTH, 1);
        return k.getTimeInMillis();
    }

    private void render() {
        TrackerService s = TrackerService.I;
        int st = s == null ? TrackerService.ST_IDLE : s.state;
        boolean tracking = st == TrackerService.ST_TRACK || st == TrackerService.ST_RING;
        Ui.gone(idle, tracking);
        Ui.gone(track, !tracking);
        if (!hasSensors()) {
            tStatus.setText("Toque em Começar para permitir os sensores");
            tStatus.setTextColor(Ui.DANGER);
        } else if (st == TrackerService.ST_SYNC && s != null) {
            String t = s.bleOn ? (s.bleClients > 0 ? "Celular conectado" : "Visível para o celular até " + Ui.hm(s.syncUntil))
                    : (s.bleError != null ? s.bleError : "Bluetooth indisponível");
            tStatus.setText(t);
            tStatus.setTextColor(s.bleOn ? Ui.MUTED : Ui.DANGER);
        } else {
            tStatus.setText(tracking ? "acompanhando" : "pronto");
            tStatus.setTextColor(Ui.MUTED);
        }
        tTime.setText(String.format(java.util.Locale.US, "%02d:%02d", wakeMin / 60, wakeMin % 60));
        long wb = nextWake();
        long mins = (wb - System.currentTimeMillis()) / 60000L;
        tSpan.setText("em " + (mins / 60) + " h " + String.format(java.util.Locale.US, "%02d", mins % 60) + " · janela desde " + Ui.hm(wb - windowMin * 60000L));
        bWin.setText("Janela " + windowMin + " min");
        int n = Store.list(this).size();
        tFoot.setText(n == 0 ? "No celular, abra o Maré e conecte o relógio." : n + (n == 1 ? " sessão salva" : " sessões salvas") + " · importe pelo Maré no celular");
        if (tracking && s != null) {
            long now = System.currentTimeMillis();
            if ("night".equals(s.mode)) {
                tTrackTitle.setText("Dormindo");
                tTrackLine.setText(s.snoozeUntil > 0 ? "Soneca até " + Ui.hm(s.snoozeUntil)
                        : "Janela " + Ui.hm(s.wakeBy - s.windowMin * 60000L) + "–" + Ui.hm(s.wakeBy));
            } else {
                tTrackTitle.setText("Cochilo " + s.napMin + "′");
                tTrackLine.setText(s.onsetAt > 0 ? "Acordo às " + Ui.hm(s.onsetAt + s.napMin * 60000L)
                        : "Esperando você dormir · fique parado");
            }
            tHr.setText(now - s.lastHrAt < 120000 ? "FC " + s.lastHr + " bpm" : "Lendo a frequência cardíaca…");
        }
    }

    // ---------------- ações ----------------

    private void startNight() {
        if (!hasSensors()) { askPermissions(); return; }
        Intent i = new Intent(this, TrackerService.class).setAction(TrackerService.A_NIGHT)
                .putExtra("wakeBy", nextWake()).putExtra("window", windowMin);
        startForegroundService(i);
    }

    private void startNap(int m) {
        if (!hasSensors()) { askPermissions(); return; }
        startForegroundService(new Intent(this, TrackerService.class).setAction(TrackerService.A_NAP).putExtra("min", m));
    }

    /** Fica visível ao celular por 10 min sempre que o app é aberto (para importar ou começar de lá). */
    private void openSync() {
        TrackerService s = TrackerService.I;
        if (s != null && (s.state == TrackerService.ST_TRACK || s.state == TrackerService.ST_RING)) return;
        if (!hasSensors() && !hasBt()) return;
        try {
            startForegroundService(new Intent(this, TrackerService.class).setAction(TrackerService.A_SYNC));
        } catch (Exception ignored) { }
    }

    // ---------------- permissões ----------------

    private boolean granted(String p) { return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }

    private boolean hasSensors() { return granted(Manifest.permission.BODY_SENSORS); }

    private boolean hasBt() {
        return Build.VERSION.SDK_INT < 31 || (granted(Manifest.permission.BLUETOOTH_ADVERTISE) && granted(Manifest.permission.BLUETOOTH_CONNECT));
    }

    private void askPermissions() {
        List<String> p = new ArrayList<>();
        if (!hasSensors()) p.add(Manifest.permission.BODY_SENSORS);
        if (Build.VERSION.SDK_INT >= 31) {
            if (!granted(Manifest.permission.BLUETOOTH_ADVERTISE)) p.add(Manifest.permission.BLUETOOTH_ADVERTISE);
            if (!granted(Manifest.permission.BLUETOOTH_CONNECT)) p.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) p.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!p.isEmpty()) requestPermissions(p.toArray(new String[0]), 1);
        else askBackground();
    }

    private void askBackground() {
        if (Build.VERSION.SDK_INT >= 33 && hasSensors() && !granted(Manifest.permission.BODY_SENSORS_BACKGROUND)) {
            requestPermissions(new String[]{Manifest.permission.BODY_SENSORS_BACKGROUND}, 2);
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code == 1) { askBackground(); openSync(); }
        render();
    }
}
