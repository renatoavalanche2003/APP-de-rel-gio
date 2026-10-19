package app.mare.watch;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Sessões salvas no relógio: <id>.json (metadados) + <id>.bin (épocas). Guarda as 12 mais recentes. */
final class Store {
    private Store() {}

    private static final int KEEP = 12;

    static File dir(Context c) {
        File d = new File(c.getFilesDir(), "sessions");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    static synchronized void save(Context c, JSONObject meta, byte[] epochs, boolean partial) {
        try {
            String id = meta.getString("id");
            File d = dir(c);
            write(new File(d, id + ".bin"), epochs);
            meta.put("partial", partial);
            write(new File(d, id + ".json"), meta.toString().getBytes(StandardCharsets.UTF_8));
            if (!partial) prune(c);
        } catch (Exception ignored) {
        }
    }

    static synchronized List<JSONObject> list(Context c) {
        List<JSONObject> out = new ArrayList<>();
        File[] fs = dir(c).listFiles();
        if (fs == null) return out;
        for (File f : fs) {
            if (!f.getName().endsWith(".json")) continue;
            try {
                JSONObject j = new JSONObject(new String(read(f), StandardCharsets.UTF_8));
                if (!j.optBoolean("partial")) out.add(j);
            } catch (Exception ignored) {
            }
        }
        Collections.sort(out, (a, b) -> Long.compare(b.optLong("start"), a.optLong("start")));
        return out;
    }

    static synchronized byte[] epochs(Context c, String id) {
        try {
            return read(new File(dir(c), id + ".bin"));
        } catch (Exception e) {
            return new byte[0];
        }
    }

    /** Sessões que ficaram parciais (o app foi encerrado durante a noite) viram sessões "interrompidas". */
    static synchronized int recover(Context c, String activeId) {
        int n = 0;
        File[] fs = dir(c).listFiles();
        if (fs == null) return 0;
        for (File f : fs) {
            if (!f.getName().endsWith(".json")) continue;
            try {
                JSONObject j = new JSONObject(new String(read(f), StandardCharsets.UTF_8));
                if (!j.optBoolean("partial") || j.getString("id").equals(activeId)) continue;
                byte[] e = read(new File(dir(c), j.getString("id") + ".bin"));
                int count = e.length / Codec.REC;
                long start = j.getLong("start");
                j.put("n", count);
                j.put("end", start + Math.max(1, count) * 30000L);
                if (j.optLong("alarmAt") == 0) {
                    j.put("alarmAt", j.getLong("end"));
                    j.put("reason", "interrupted");
                }
                save(c, j, e, false);
                n++;
            } catch (Exception ignored) {
            }
        }
        return n;
    }

    private static void prune(Context c) {
        List<JSONObject> all = list(c);
        for (int i = KEEP; i < all.size(); i++) {
            String id = all.get(i).optString("id");
            //noinspection ResultOfMethodCallIgnored
            new File(dir(c), id + ".json").delete();
            //noinspection ResultOfMethodCallIgnored
            new File(dir(c), id + ".bin").delete();
        }
    }

    private static void write(File f, byte[] b) throws Exception {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) {
            o.write(b);
            o.getFD().sync();
        }
        if (!tmp.renameTo(f)) throw new Exception("rename");
    }

    private static byte[] read(File f) throws Exception {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int off = 0;
            while (off < b.length) {
                int r = in.read(b, off, b.length - off);
                if (r < 0) break;
                off += r;
            }
            return b;
        }
    }
}
