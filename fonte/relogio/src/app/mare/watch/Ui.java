package app.mare.watch;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Paleta e peças de interface do relógio (mesma identidade do Maré no celular). */
final class Ui {
    private Ui() {}

    static final int NIGHT = Color.parseColor("#0b0d14");
    static final int PANEL = Color.parseColor("#171b2b");
    static final int LINE = Color.parseColor("#2a3150");
    static final int INK = Color.parseColor("#ece4d4");
    static final int MUTED = Color.parseColor("#9c9fb4");
    static final int EMBER = Color.parseColor("#ff9d5c");
    static final int ON_EMBER = Color.parseColor("#1c0f06");
    static final int DANGER = Color.parseColor("#ff7c6e");

    static int dp(Context c, float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics()));
    }

    static TextView text(Context c, String s, float sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    static TextView label(Context c, String s) {
        TextView t = text(c, s.toUpperCase(), 10, MUTED, true);
        t.setLetterSpacing(0.12f);
        return t;
    }

    static Button button(Context c, String s, boolean primary) {
        Button b = new Button(c);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, primary ? 16 : 14);
        b.setTextColor(primary ? ON_EMBER : INK);
        b.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(c, 24));
        if (primary) g.setColor(EMBER);
        else {
            g.setColor(PANEL);
            g.setStroke(dp(c, 1), LINE);
        }
        b.setBackground(g);
        b.setMinHeight(dp(c, primary ? 52 : 44));
        b.setMinimumHeight(dp(c, primary ? 52 : 44));
        b.setPadding(dp(c, 10), 0, dp(c, 10), 0);
        b.setStateListAnimator(null);
        return b;
    }

    static LinearLayout row(Context c) {
        LinearLayout r = new LinearLayout(c);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER);
        return r;
    }

    static LinearLayout.LayoutParams full(Context c, float topDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = dp(c, topDp);
        return p;
    }

    static LinearLayout.LayoutParams weight(Context c, float leftDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        p.leftMargin = dp(c, leftDp);
        return p;
    }

    static void gone(View v, boolean gone) {
        v.setVisibility(gone ? View.GONE : View.VISIBLE);
    }

    static String hm(long ms) {
        java.util.Calendar k = java.util.Calendar.getInstance();
        k.setTimeInMillis(ms);
        return String.format(java.util.Locale.US, "%02d:%02d", k.get(java.util.Calendar.HOUR_OF_DAY), k.get(java.util.Calendar.MINUTE));
    }
}
