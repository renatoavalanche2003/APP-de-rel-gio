package app.mare.watch;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.ParcelUuid;
import android.os.PowerManager;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Coração do Maré no relógio. Estados:
 *  OCIOSO -> VISÍVEL (Bluetooth anunciando para o celular, 10 min)
 *         -> ACOMPANHANDO (acelerômetro + FC a cada segundo, épocas de 30 s, lógica do alarme)
 *         -> TOCANDO (vibração no pulso, depois som) -> VISÍVEL (para importar a noite)
 */
public class TrackerService extends Service implements SensorEventListener {
    public static final String A_NIGHT = "app.mare.watch.NIGHT";
    public static final String A_NAP = "app.mare.watch.NAP";
    public static final String A_STOP = "app.mare.watch.STOP";
    public static final String A_DISMISS = "app.mare.watch.DISMISS";
    public static final String A_SNOOZE = "app.mare.watch.SNOOZE";
    public static final String A_DEADLINE = "app.mare.watch.DEADLINE";
    public static final String A_SYNC = "app.mare.watch.SYNC";

    public static final int ST_IDLE = 0, ST_TRACK = 1, ST_RING = 2, ST_SYNC = 3;
    private static final int NOTIF_RUN = 1, NOTIF_ALARM = 2;
    private static final String CH_RUN = "run", CH_ALARM = "alarm";
    private static final long EPOCH = 30000L, SYNC_MS = 10 * 60000L, MIN = 60000L;
    private static final double SENS = 3.0; // pulso: sinal forte, limiar = 3x o ruído do próprio sensor

    public interface Listener { void onChange(); }
    public static volatile TrackerService I;
    public static final CopyOnWriteArrayList<Listener> LISTENERS = new CopyOnWriteArrayList<>();

    // ---- estado lido pela interface ----
    public volatile int state = ST_IDLE;
    public volatile String mode, reason;
    public volatile long start, wakeBy, onsetAt, alarmAt, snoozeUntil, syncUntil, lastHrAt;
    public volatile int windowMin, napMin, lastHr, nEpochs, bleClients;
    public volatile boolean bleOn;
    public volatile String bleError;

    private HandlerThread thread;
    private Handler h;
    private SensorManager sm;
    private PowerManager.WakeLock wl;
    private Vibrator vib;
    private Ringtone ring;
    private NotificationManager nm;
    private final Ble ble = new Ble();

    // ---- sessão ----
    private String id;
    private final ByteArrayOutputStream ep = new ByteArrayOutputStream();
    private int snoozes, stillRun, onsetIdx = -1, uiTick;
    private boolean winChecked;
    private final ArrayDeque<Boolean> lastMoves = new ArrayDeque<>();

    // ---- segundo corrente ----
    private float[] ema;
    private long lastTs;
    private double sPeak, sSq;
    private int sN;
    private final double[] rmsHist = new double[600];
    private int rmsCount, rmsPos;
    private double floor = 0.03;
    private final ArrayDeque<double[]> recent = new ArrayDeque<>(); // {t, intensidade, movimento}

    // ---- época corrente ----
    private double eA;
    private int eM, eSecs;
    private final ArrayList<Float> eHr = new ArrayList<>();
    private long nextEpoch;

    private final Runnable tick = this::tick;
    private final Runnable endSync = this::endSync;
    private final Runnable escalate1 = this::escalate1;
    private final Runnable escalate2 = this::escalate2;
    private final Runnable checkpoint = this::checkpoint;

    // ================= ciclo de vida =================

    @Override public void onCreate() {
        super.onCreate();
        I = this;
        nm = getSystemService(NotificationManager.class);
        sm = getSystemService(SensorManager.class);
        if (Build.VERSION.SDK_INT >= 31) vib = getSystemService(VibratorManager.class).getDefaultVibrator();
        else vib = getSystemService(Vibrator.class);
        thread = new HandlerThread("mare");
        thread.start();
        h = new Handler(thread.getLooper());
        NotificationChannel run = new NotificationChannel(CH_RUN, "Acompanhando o sono", NotificationManager.IMPORTANCE_LOW);
        run.setShowBadge(false);
        NotificationChannel al = new NotificationChannel(CH_ALARM, "Despertador", NotificationManager.IMPORTANCE_HIGH);
        al.setSound(null, null);
        al.enableVibration(false);
        al.setBypassDnd(true);
        nm.createNotificationChannel(run);
        nm.createNotificationChannel(al);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent it, int flags, int startId) {
        final String a = it == null ? null : it.getAction();
        if (A_NIGHT.equals(a) || A_NAP.equals(a) || A_DEADLINE.equals(a) || A_SYNC.equals(a)) {
            goForeground(text("Maré"));
        }
        if (A_NIGHT.equals(a)) {
            final long wb = it.getLongExtra("wakeBy", 0);
            final int win = it.getIntExtra("window", 30);
            h.post(() -> begin("night", wb, win, 0));
        } else if (A_NAP.equals(a)) {
            final int m = it.getIntExtra("min", 20);
            h.post(() -> begin("nap", 0, 0, m));
        } else if (A_STOP.equals(a)) {
            h.post(() -> finish(true));
        } else if (A_DISMISS.equals(a)) {
            h.post(() -> finish(false));
        } else if (A_SNOOZE.equals(a)) {
            h.post(this::snooze);
        } else if (A_DEADLINE.equals(a)) {
            h.post(() -> {
                if (state == ST_TRACK) fire("night".equals(mode) ? "limit" : "cap");
                else if (state != ST_RING) fireOrphan();
            });
        } else if (A_SYNC.equals(a)) {
            h.post(this::openSync);
        } else if (state == ST_IDLE) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        ble.stop();
        try { sm.unregisterListener(this); } catch (Exception ignored) { }
        releaseWake();
        stopAlert();
        if (id != null && (state == ST_TRACK || state == ST_RING)) checkpoint();
        state = ST_IDLE;
        I = null;
        thread.quitSafely();
        notifyUi();
        super.onDestroy();
    }

    // ================= começar / terminar =================

    private void begin(String m, long wb, int win, int nap) {
        if (state == ST_TRACK || state == ST_RING) return;
        if (!has(Manifest.permission.BODY_SENSORS)) { notifyUi(); return; }
        h.removeCallbacks(endSync);
        ble.stop();
        syncUntil = 0;
        mode = m;
        start = System.currentTimeMillis();
        id = "w" + start;
        wakeBy = wb;
        windowMin = win;
        napMin = nap;
        onsetAt = 0; alarmAt = 0; snoozeUntil = 0; reason = null;
        snoozes = 0; stillRun = 0; onsetIdx = -1; nEpochs = 0; winChecked = false;
        ep.reset(); lastMoves.clear(); recent.clear(); eHr.clear();
        ema = null; rmsCount = 0; rmsPos = 0; floor = 0.03;
        eA = 0; eM = 0; eSecs = 0; sPeak = 0; sSq = 0; sN = 0;
        nextEpoch = start + EPOCH;

        PowerManager pm = getSystemService(PowerManager.class);
        wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mare:sono");
        wl.acquire(16 * 60 * MIN);

        Sensor acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (acc != null) sm.registerListener(this, acc, 40000, 0, h); // 25 Hz
        Sensor hr = sm.getDefaultSensor(Sensor.TYPE_HEART_RATE);
        if (hr != null) sm.registerListener(this, hr, SensorManager.SENSOR_DELAY_NORMAL, 0, h);

        long deadline = "night".equals(mode) ? wakeBy : start + (napMin + 25) * MIN;
        scheduleDeadline(deadline);
        state = ST_TRACK;
        goForeground(trackText());
        h.removeCallbacks(tick);
        h.postDelayed(tick, 1000);
        h.removeCallbacks(checkpoint);
        h.postDelayed(checkpoint, 5 * MIN);
        notifyUi();
    }

    private void finish(boolean manual) {
        if (state != ST_TRACK && state != ST_RING) return;
        stopAlert();
        h.removeCallbacks(tick);
        h.removeCallbacks(checkpoint);
        try { sm.unregisterListener(this); } catch (Exception ignored) { }
        releaseWake();
        cancelDeadline();
        if (id == null) { // alarme de segurança sem sessão (o app tinha sido encerrado)
            state = ST_IDLE;
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            notifyUi();
            return;
        }
        long now = System.currentTimeMillis();
        if (alarmAt == 0) { alarmAt = now; reason = "manual"; }
        if (manual && reason == null) reason = "manual";
        byte[] all = ep.toByteArray();
        int n = all.length / Codec.REC;
        if (snoozes == 0 && !"manual".equals(reason)) {
            n = (int) Math.max(0, Math.min(n, (alarmAt - start) / EPOCH)); // depois do alarme é você acordando
        }
        byte[] data = Arrays.copyOf(all, n * Codec.REC);
        try {
            JSONObject meta = meta(n);
            Store.save(this, meta, data, false);
        } catch (Exception ignored) { }
        id = null;
        state = ST_IDLE;
        openSync();
    }

    private JSONObject meta(int n) throws Exception {
        JSONObject j = new JSONObject();
        j.put("id", id);
        j.put("mode", mode);
        j.put("start", start);
        j.put("end", start + Math.max(1, n) * EPOCH);
        j.put("n", n);
        if ("night".equals(mode)) { j.put("wakeBy", wakeBy); j.put("win", windowMin); }
        else j.put("nap", napMin);
        if (onsetAt > 0) j.put("onset", onsetAt);
        if (alarmAt > 0) { j.put("alarmAt", alarmAt); j.put("reason", reason); }
        j.put("sz", snoozes);
        return j;
    }

    private void checkpoint() { // salva a noite parcial a cada 5 min: se o app morrer, os dados ficam
        if (id == null) return;
        try {
            byte[] all = ep.toByteArray();
            Store.save(this, meta(all.length / Codec.REC), all, true);
        } catch (Exception ignored) { }
        if (state == ST_TRACK || state == ST_RING) h.postDelayed(checkpoint, 5 * MIN);
    }

    // ================= visível para o celular =================

    private void openSync() {
        if (state == ST_TRACK || state == ST_RING) return;
        state = ST_SYNC;
        syncUntil = System.currentTimeMillis() + SYNC_MS;
        ble.start();
        goForeground(bleOn ? "Visível para o celular até " + Ui.hm(syncUntil) : "Ligue o Bluetooth para importar no celular");
        h.removeCallbacks(endSync);
        h.postDelayed(endSync, SYNC_MS);
        notifyUi();
    }

    private void endSync() {
        if (state != ST_SYNC) return;
        ble.stop();
        state = ST_IDLE;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        notifyUi();
    }

    // ================= sensores =================

    @Override public void onSensorChanged(SensorEvent e) {
        int type = e.sensor.getType();
        if (type == Sensor.TYPE_ACCELEROMETER) {
            float[] v = e.values;
            if (ema == null) { ema = new float[]{v[0], v[1], v[2]}; lastTs = e.timestamp; return; }
            double dt = Math.min(0.2, Math.max(0.005, (e.timestamp - lastTs) / 1e9));
            lastTs = e.timestamp;
            double al = 1 - Math.exp(-dt / 0.6), s = 0;
            for (int i = 0; i < 3; i++) {
                double hp = v[i] - ema[i];
                ema[i] += al * hp;
                s += hp * hp;
            }
            double mag = Math.sqrt(s);
            if (mag > sPeak) sPeak = mag;
            sSq += mag * mag;
            sN++;
        } else if (type == Sensor.TYPE_HEART_RATE) {
            float bpm = e.values[0];
            if (bpm >= 30 && bpm <= 220 && e.accuracy >= SensorManager.SENSOR_STATUS_ACCURACY_LOW) {
                eHr.add(bpm);
                lastHr = Math.round(bpm);
                lastHrAt = System.currentTimeMillis();
            }
        }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    private void tick() {
        long now = System.currentTimeMillis();
        if (state != ST_TRACK && state != ST_RING) return;
        int n = sN;
        double peak = sPeak, rms = n > 0 ? Math.sqrt(sSq / n) : 0;
        sPeak = 0; sSq = 0; sN = 0;
        if (n > 0) {
            rmsHist[rmsPos] = rms;
            rmsPos = (rmsPos + 1) % rmsHist.length;
            if (rmsCount < rmsHist.length) rmsCount++;
            if (rmsCount >= 20 && rmsPos % 10 == 0) {
                double[] s = Arrays.copyOf(rmsHist, rmsCount);
                Arrays.sort(s);
                floor = s[(int) (s.length * 0.3)];
            }
        }
        double thr = Math.max(0.012, floor * SENS);
        double in = n > 0 ? (peak - thr) / thr : 0;
        if (in < 0.15) in = 0;
        if (in > 10) in = 10;
        boolean mv = in >= 0.6;
        recent.addLast(new double[]{now, in, mv ? 1 : 0});
        while (!recent.isEmpty() && recent.peekFirst()[0] < now - 20000) recent.pollFirst();
        if (n > 0) { eA += in; if (mv) eM++; eSecs++; }
        while (now >= nextEpoch) closeEpoch();
        if (state == ST_TRACK) check(now);
        if (++uiTick % 5 == 0) notifyUi();
        if (uiTick % 60 == 0 && state == ST_TRACK) goForeground(trackText());
        h.postDelayed(tick, 1000);
    }

    private void closeEpoch() {
        boolean gap = eSecs < 10;
        double a = gap ? 0 : Math.round(eA * 10) / 10.0;
        int m = gap ? 0 : eM;
        int hr = 0;
        double sd = 0;
        if (eHr.size() >= 3) {
            double sum = 0;
            for (float x : eHr) sum += x;
            double mean = sum / eHr.size(), sq = 0;
            for (float x : eHr) sq += (x - mean) * (x - mean);
            hr = (int) Math.round(mean);
            sd = Math.sqrt(sq / eHr.size());
        }
        Codec.putEpoch(ep, a, m, hr, sd, gap, hr == 0);
        nEpochs++;
        boolean move = !gap && Codec.isMove(a, m);
        lastMoves.addLast(move);
        if (lastMoves.size() > 4) lastMoves.pollFirst();
        stillRun = (!gap && !move) ? stillRun + 1 : 0;
        int need = "nap".equals(mode) ? 6 : 10; // 3 min (cochilo) ou 5 min (noite) parado = pegou no sono
        if (onsetIdx < 0 && stillRun >= need) {
            onsetIdx = nEpochs - need;
            onsetAt = start + onsetIdx * EPOCH;
        }
        eA = 0; eM = 0; eSecs = 0;
        eHr.clear();
        nextEpoch += EPOCH;
    }

    // ================= alarme =================

    private void check(long now) {
        if (snoozeUntil > 0) {
            if (now >= snoozeUntil) { snoozeUntil = 0; fire("snooze"); }
            return;
        }
        if (alarmAt > 0) return;
        int mvS = 0;
        double sumI = 0;
        for (double[] r : recent) { mvS += (int) r[2]; sumI += r[1]; }
        boolean moving = mvS >= 2 || sumI >= 2.5;
        boolean slept = onsetIdx >= 0;
        if ("night".equals(mode)) {
            if (now >= wakeBy) { fire("limit"); return; }
            if (slept && now >= wakeBy - windowMin * MIN) {
                if (moving) { fire("move"); return; }
                if (!winChecked) {
                    winChecked = true;
                    if (lastMoves.contains(Boolean.TRUE)) fire("light");
                }
            }
        } else {
            long dur = napMin * MIN;
            if (onsetAt > 0) {
                long target = onsetAt + dur;
                if (now >= target) { fire("nap"); return; }
                if (napMin >= 90 && now >= target - 15 * MIN && moving) { fire("move"); return; }
            }
            if (now >= start + dur + 25 * MIN) fire("cap");
        }
    }

    private void fire(String r) {
        if (state == ST_RING) return;
        if (alarmAt == 0) { alarmAt = System.currentTimeMillis(); reason = r; }
        state = ST_RING;
        startAlert();
        showAlarm(r);
        notifyUi();
    }

    private void fireOrphan() { // o despertador de segurança disparou e não havia sessão viva
        id = null;
        mode = null;
        reason = "limit";
        alarmAt = System.currentTimeMillis();
        state = ST_RING;
        startAlert();
        showAlarm("limit");
        notifyUi();
    }

    private void snooze() {
        if (state != ST_RING || id == null) { finish(false); return; }
        stopAlert();
        snoozes++;
        snoozeUntil = System.currentTimeMillis() + 5 * MIN;
        state = ST_TRACK;
        goForeground("Soneca até " + Ui.hm(snoozeUntil));
        notifyUi();
    }

    private void startAlert() {
        // 0–25 s: pulsos suaves · 25–60 s: fortes · depois de 60 s: também som de alarme
        vibrate(new long[]{0, 350, 650}, new int[]{0, 110, 0});
        h.removeCallbacks(escalate1);
        h.removeCallbacks(escalate2);
        h.postDelayed(escalate1, 25000);
    }

    private void escalate1() {
        if (state != ST_RING) return;
        vibrate(new long[]{0, 700, 300, 700, 900}, new int[]{0, 255, 0, 255, 0});
        h.postDelayed(escalate2, 35000);
    }

    private void escalate2() {
        if (state != ST_RING) return;
        try {
            Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            if (u == null) return;
            ring = RingtoneManager.getRingtone(this, u);
            if (ring == null) return;
            ring.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            ring.setLooping(true);
            ring.play();
        } catch (Exception ignored) { }
    }

    private void vibrate(long[] t, int[] amp) {
        if (vib == null || !vib.hasVibrator()) return;
        VibrationEffect fx = VibrationEffect.createWaveform(t, amp, 1);
        if (Build.VERSION.SDK_INT >= 33) {
            vib.vibrate(fx, new VibrationAttributes.Builder().setUsage(VibrationAttributes.USAGE_ALARM).build());
        } else {
            vib.vibrate(fx, new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
        }
    }

    private void stopAlert() {
        h.removeCallbacks(escalate1);
        h.removeCallbacks(escalate2);
        try { if (vib != null) vib.cancel(); } catch (Exception ignored) { }
        try { if (ring != null) ring.stop(); } catch (Exception ignored) { }
        ring = null;
        nm.cancel(NOTIF_ALARM);
    }

    static String reasonText(String r) {
        if (r == null) return "";
        switch (r) {
            case "move": return "Movimento na janela: sono leve ou virada de ciclo.";
            case "light": return "Você já estava em sono leve quando a janela abriu.";
            case "limit": return "Horário limite: sem movimento na janela.";
            case "nap": return "Fim do cochilo, contado de quando você dormiu.";
            case "cap": return "Teto do cochilo: o sono não veio a tempo.";
            case "snooze": return "Fim da soneca.";
            default: return "";
        }
    }

    private void showAlarm(String r) {
        Intent ai = new Intent(this, AlarmActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent full = PendingIntent.getActivity(this, 10, ai, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CH_ALARM)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Hora de acordar")
                .setContentText(reasonText(r))
                .setCategory(Notification.CATEGORY_ALARM)
                .setFullScreenIntent(full, true)
                .setContentIntent(full)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Acordei", servicePi(A_DISMISS, 11)).build())
                .addAction(new Notification.Action.Builder(null, "Soneca 5 min", servicePi(A_SNOOZE, 12)).build())
                .build();
        nm.notify(NOTIF_ALARM, n);
        try { startActivity(ai); } catch (Exception ignored) { }
    }

    private PendingIntent servicePi(String action, int code) {
        Intent i = new Intent(this, TrackerService.class).setAction(action);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ---- despertador de segurança do sistema (toca mesmo se o processo morrer) ----

    private PendingIntent deadlinePi() {
        Intent i = new Intent(this, DeadlineReceiver.class).setAction(A_DEADLINE);
        return PendingIntent.getBroadcast(this, 20, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void scheduleDeadline(long at) {
        try {
            AlarmManager am = getSystemService(AlarmManager.class);
            PendingIntent show = PendingIntent.getActivity(this, 21, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), deadlinePi());
        } catch (Exception ignored) { }
    }

    private void cancelDeadline() {
        try { getSystemService(AlarmManager.class).cancel(deadlinePi()); } catch (Exception ignored) { }
    }

    // ================= notificação contínua =================

    private String trackText() {
        if ("night".equals(mode)) return "Janela " + Ui.hm(wakeBy - windowMin * MIN) + "–" + Ui.hm(wakeBy);
        if (onsetAt > 0) return "Cochilo · acordo às " + Ui.hm(onsetAt + napMin * MIN);
        return "Cochilo · esperando você dormir";
    }

    private String text(String s) { return s; }

    private void goForeground(String content) {
        PendingIntent open = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CH_RUN)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Maré")
                .setContentText(content)
                .setContentIntent(open)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                int t = 0;
                if (has(Manifest.permission.BODY_SENSORS)) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH;
                if (hasBt()) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
                if (t == 0) { stopSelf(); return; }
                startForeground(NOTIF_RUN, n, t);
            } else {
                startForeground(NOTIF_RUN, n);
            }
        } catch (Exception e) {
            stopSelf();
        }
    }

    private void releaseWake() {
        try { if (wl != null && wl.isHeld()) wl.release(); } catch (Exception ignored) { }
        wl = null;
    }

    boolean has(String p) {
        return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED;
    }

    boolean hasBt() {
        if (Build.VERSION.SDK_INT < 31) return true;
        return has(Manifest.permission.BLUETOOTH_ADVERTISE) && has(Manifest.permission.BLUETOOTH_CONNECT);
    }

    void notifyUi() {
        for (Listener l : LISTENERS) {
            try { l.onChange(); } catch (Exception ignored) { }
        }
    }

    // ================= Bluetooth: o celular lê as noites e manda começar =================

    private final class Ble {
        private BluetoothGattServer gs;
        private BluetoothLeAdvertiser adv;
        private final Map<String, byte[]> resp = new HashMap<>();
        private final Map<String, ByteArrayOutputStream> prep = new HashMap<>();

        private final AdvertiseCallback advCb = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings s) { bleError = null; notifyUi(); }
            @Override public void onStartFailure(int code) { bleError = "anúncio falhou (" + code + ")"; bleOn = false; notifyUi(); }
        };

        void start() {
            if (bleOn) return;
            if (!hasBt()) { bleError = "sem permissão de Bluetooth"; return; }
            try {
                BluetoothManager bm = getSystemService(BluetoothManager.class);
                BluetoothAdapter ad = bm == null ? null : bm.getAdapter();
                if (ad == null || !ad.isEnabled()) { bleError = "Bluetooth desligado"; return; }
                gs = bm.openGattServer(TrackerService.this, cb);
                if (gs == null) { bleError = "servidor indisponível"; return; }
                BluetoothGattService s = new BluetoothGattService(Codec.SVC, BluetoothGattService.SERVICE_TYPE_PRIMARY);
                s.addCharacteristic(new BluetoothGattCharacteristic(Codec.CTRL,
                        BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE));
                s.addCharacteristic(new BluetoothGattCharacteristic(Codec.DATA,
                        BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ));
                gs.addService(s);
                adv = ad.getBluetoothLeAdvertiser();
                if (adv == null) { gs.close(); gs = null; bleError = "este relógio não anuncia BLE"; return; }
                AdvertiseSettings st = new AdvertiseSettings.Builder()
                        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                        .setConnectable(true).setTimeout(0).build();
                AdvertiseData data = new AdvertiseData.Builder().addServiceUuid(new ParcelUuid(Codec.SVC)).build();
                AdvertiseData scan = new AdvertiseData.Builder().setIncludeDeviceName(true).build();
                adv.startAdvertising(st, data, scan, advCb);
                bleOn = true;
                bleError = null;
            } catch (SecurityException e) {
                bleError = "sem permissão de Bluetooth";
            } catch (Exception e) {
                bleError = "erro no Bluetooth";
            }
        }

        void stop() {
            try { if (adv != null) adv.stopAdvertising(advCb); } catch (Exception ignored) { }
            try { if (gs != null) gs.close(); } catch (Exception ignored) { }
            adv = null;
            gs = null;
            bleOn = false;
            bleClients = 0;
            synchronized (resp) { resp.clear(); prep.clear(); }
        }

        private void reply(BluetoothDevice d, int req, int status, int off, byte[] v) {
            try { if (gs != null) gs.sendResponse(d, req, status, off, v); } catch (SecurityException ignored) { }
        }

        private final BluetoothGattServerCallback cb = new BluetoothGattServerCallback() {
            @Override public void onConnectionStateChange(BluetoothDevice d, int status, int newState) {
                if (newState == BluetoothProfile.STATE_CONNECTED) bleClients++;
                else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    bleClients = Math.max(0, bleClients - 1);
                    synchronized (resp) { resp.remove(d.getAddress()); prep.remove(d.getAddress()); }
                }
                notifyUi();
            }

            @Override public void onCharacteristicWriteRequest(BluetoothDevice d, int req, BluetoothGattCharacteristic ch,
                                                               boolean prepared, boolean needResp, int off, byte[] v) {
                String k = d.getAddress();
                if (prepared) {
                    synchronized (resp) {
                        ByteArrayOutputStream b = prep.get(k);
                        if (b == null) { b = new ByteArrayOutputStream(); prep.put(k, b); }
                        if (v != null) b.write(v, 0, v.length);
                    }
                    if (needResp) reply(d, req, BluetoothGatt.GATT_SUCCESS, off, v);
                    return;
                }
                byte[] out = handle(v);
                synchronized (resp) { resp.put(k, out); }
                if (needResp) reply(d, req, BluetoothGatt.GATT_SUCCESS, 0, null);
            }

            @Override public void onExecuteWrite(BluetoothDevice d, int req, boolean execute) {
                String k = d.getAddress();
                ByteArrayOutputStream b;
                synchronized (resp) { b = prep.remove(k); }
                if (execute && b != null) {
                    byte[] out = handle(b.toByteArray());
                    synchronized (resp) { resp.put(k, out); }
                }
                reply(d, req, BluetoothGatt.GATT_SUCCESS, 0, null);
            }

            @Override public void onCharacteristicReadRequest(BluetoothDevice d, int req, int off, BluetoothGattCharacteristic ch) {
                byte[] r;
                synchronized (resp) { r = resp.get(d.getAddress()); }
                if (r == null) r = "{}".getBytes(StandardCharsets.UTF_8);
                if (off > r.length) { reply(d, req, BluetoothGatt.GATT_INVALID_OFFSET, off, null); return; }
                reply(d, req, BluetoothGatt.GATT_SUCCESS, off, Arrays.copyOfRange(r, off, r.length));
            }
        };
    }

    private byte[] handle(byte[] v) {
        try {
            if (v == null || v.length == 0) return err("comando vazio");
            List<JSONObject> list = Store.list(this);
            switch (v[0]) {
                case Codec.OP_LIST: {
                    JSONObject j = new JSONObject();
                    JSONObject now = new JSONObject();
                    now.put("st", state);
                    now.put("hr", System.currentTimeMillis() - lastHrAt < 120000 ? lastHr : 0);
                    if (mode != null) now.put("mode", mode);
                    j.put("v", 1);
                    j.put("now", now);
                    JSONArray s = new JSONArray();
                    for (int i = 0; i < list.size() && i < 6; i++) {
                        JSONObject m = list.get(i);
                        JSONObject x = new JSONObject();
                        x.put("i", i);
                        x.put("id", m.optString("id"));
                        x.put("s", m.optLong("start") / 1000);
                        x.put("e", m.optLong("end") / 1000);
                        x.put("m", "night".equals(m.optString("mode")) ? "n" : "z");
                        x.put("n", m.optInt("n"));
                        s.put(x);
                    }
                    j.put("s", s);
                    return j.toString().getBytes(StandardCharsets.UTF_8);
                }
                case Codec.OP_META: {
                    int i = v[1] & 0xff;
                    if (i >= list.size()) return err("sessão inexistente");
                    return list.get(i).toString().getBytes(StandardCharsets.UTF_8);
                }
                case Codec.OP_CHUNK: {
                    int i = v[1] & 0xff, k = Codec.u16(v, 2);
                    if (i >= list.size()) return new byte[0];
                    return Codec.chunk(Store.epochs(this, list.get(i).optString("id")), k);
                }
                case Codec.OP_NIGHT: {
                    final long wb = Codec.u32(v, 1) * 1000L;
                    final int win = v.length > 5 ? (v[5] & 0xff) : 30;
                    if (wb < System.currentTimeMillis() + 5 * MIN) return err("horário já passou");
                    getSharedPreferences("mare", MODE_PRIVATE).edit().putInt("win", win).apply();
                    h.postDelayed(() -> begin("night", wb, win, 0), 2500);
                    return ok();
                }
                case Codec.OP_NAP: {
                    final int m = Math.max(5, v[1] & 0xff);
                    h.postDelayed(() -> begin("nap", 0, 0, m), 2500);
                    return ok();
                }
                case Codec.OP_STOP: {
                    h.post(() -> finish(true));
                    return ok();
                }
                default:
                    return err("comando desconhecido");
            }
        } catch (Exception e) {
            return err("falha no relógio");
        }
    }

    private static byte[] ok() { return "{\"ok\":1}".getBytes(StandardCharsets.UTF_8); }

    private static byte[] err(String m) {
        try {
            JSONObject j = new JSONObject();
            j.put("err", m);
            return j.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "{\"err\":\"?\"}".getBytes(StandardCharsets.UTF_8);
        }
    }

    // usado pela interface
    static void send(Context c, String action) {
        c.startService(new Intent(c, TrackerService.class).setAction(action));
    }
}
