package app.mare.watch;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.UUID;

/**
 * Protocolo entre o relógio e o Maré no celular (Bluetooth LE, GATT).
 * Java puro: compila e testa fora do Android.
 *
 * Época (30 s) = 6 bytes, little-endian:
 *   [0..1] atividade x10 (uint16) · [2] segundos com movimento · [3] FC média (bpm, 0 = sem leitura)
 *   [4] DP da FC x10 dentro da época · [5] flags (bit0 = sem dados, bit1 = sem FC)
 *
 * Comandos escritos em CTRL (resposta lida em DATA):
 *   0x01                         LISTA  -> JSON com estado e até 6 sessões
 *   0x02 idx                     META   -> JSON da sessão
 *   0x03 idx k_lo k_hi           BLOCO  -> 80 épocas (480 bytes)
 *   0x04 t0 t1 t2 t3 janela      NOITE  -> acordar até t (segundos unix, LE) com janela em min
 *   0x05 minutos                 COCHILO
 *   0x06                         ENCERRAR
 */
public final class Codec {
    private Codec() {}

    public static final UUID SVC = UUID.fromString("4d415245-0000-4b1c-8f0a-5c3e9d7a1b20");
    public static final UUID CTRL = UUID.fromString("4d415245-0001-4b1c-8f0a-5c3e9d7a1b20");
    public static final UUID DATA = UUID.fromString("4d415245-0002-4b1c-8f0a-5c3e9d7a1b20");

    public static final int OP_LIST = 1, OP_META = 2, OP_CHUNK = 3, OP_NIGHT = 4, OP_NAP = 5, OP_STOP = 6;
    public static final int REC = 6, PER_CHUNK = 80;

    public static void putEpoch(ByteArrayOutputStream o, double act, int moveSecs, int hr, double hrSd, boolean gap, boolean noHr) {
        int a10 = (int) Math.max(0, Math.min(65535, Math.round(act * 10)));
        o.write(a10 & 0xff);
        o.write((a10 >> 8) & 0xff);
        o.write(Math.max(0, Math.min(255, moveSecs)));
        o.write(Math.max(0, Math.min(255, hr)));
        o.write((int) Math.max(0, Math.min(255, Math.round(hrSd * 10))));
        o.write((gap ? 1 : 0) | (noHr ? 2 : 0));
    }

    public static byte[] chunk(byte[] all, int k) {
        int from = k * PER_CHUNK * REC;
        if (k < 0 || from >= all.length) return new byte[0];
        int to = Math.min(all.length, from + PER_CHUNK * REC);
        return Arrays.copyOfRange(all, from, to);
    }

    public static long u32(byte[] v, int off) {
        return (v[off] & 0xffL) | ((v[off + 1] & 0xffL) << 8) | ((v[off + 2] & 0xffL) << 16) | ((v[off + 3] & 0xffL) << 24);
    }

    public static int u16(byte[] v, int off) {
        return (v[off] & 0xff) | ((v[off + 1] & 0xff) << 8);
    }

    public static boolean isMove(double act, int moveSecs) {
        return act >= 1.5 || moveSecs >= 2;
    }
}
