package app.mare.watch;

import android.app.Activity;
import android.content.Intent;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Tela do despertar: aparece por cima de tudo, acende a tela e dá dois botões grandes. */
public class AlarmActivity extends Activity implements TrackerService.Listener {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView clock;
    private final Runnable tick = new Runnable() {
        @Override public void run() { clock.setText(Ui.hm(System.currentTimeMillis())); ui.postDelayed(this, 5000); }
    };

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        int w = getResources().getDisplayMetrics().widthPixels;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding((int) (w * 0.12), (int) (w * 0.08), (int) (w * 0.12), (int) (w * 0.08));
        GradientDrawable sun = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{Ui.NIGHT, 0xFF5A2628, 0xFFC4532E, 0xFFFF9D5C});
        root.setBackground(sun);

        TrackerService s = TrackerService.I;
        String why = s == null ? "" : TrackerService.reasonText(s.reason);
        boolean nap = s != null && "nap".equals(s.mode);
        root.addView(Ui.label(this, nap ? "Fim do cochilo" : "Bom dia"));
        clock = Ui.text(this, Ui.hm(System.currentTimeMillis()), 44, 0xFFFFF3E4, false);
        root.addView(clock);
        TextView r = Ui.text(this, why, 11, 0xFFFFF3E4, false);
        root.addView(r, Ui.full(this, 2));

        Button ok = Ui.button(this, "Acordei", true);
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(Ui.dp(this, 26));
        g.setColor(0xFFFFF3E4);
        ok.setBackground(g);
        ok.setTextColor(0xFF2A140B);
        ok.setOnClickListener(v -> {
            TrackerService.send(this, TrackerService.A_DISMISS);
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            finish();
        });
        root.addView(ok, Ui.full(this, 10));

        Button snooze = Ui.button(this, "Soneca 5 min", false);
        snooze.setOnClickListener(v -> { TrackerService.send(this, TrackerService.A_SNOOZE); finish(); });
        root.addView(snooze, Ui.full(this, 6));
        setContentView(root);
    }

    @Override protected void onResume() {
        super.onResume();
        TrackerService.LISTENERS.add(this);
        ui.post(tick);
        onChange();
    }

    @Override protected void onPause() {
        TrackerService.LISTENERS.remove(this);
        ui.removeCallbacks(tick);
        super.onPause();
    }

    @Override public void onChange() {
        ui.post(() -> {
            TrackerService s = TrackerService.I;
            if (s == null || s.state != TrackerService.ST_RING) finish();
        });
    }
}
