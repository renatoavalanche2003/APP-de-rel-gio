package app.mare.watch;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Despertador de segurança: o sistema acorda o app no horário limite mesmo que o processo tenha morrido. */
public class DeadlineReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        Intent s = new Intent(c, TrackerService.class).setAction(TrackerService.A_DEADLINE);
        try {
            c.startForegroundService(s);
        } catch (Exception e) {
            try { c.startService(s); } catch (Exception ignored) { }
        }
    }
}
