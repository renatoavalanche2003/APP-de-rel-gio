# Maré — despertador de ciclo

Acompanha o sono e acorda você no sono leve, dentro de uma janela antes do horário limite.

- **Celular:** abra **https://renatoavalanche2003.github.io/APP-de-rel-gio/** no Chrome e use "Adicionar à tela inicial". Mede movimento pelo acelerômetro e ronco pelo microfone.
- **Galaxy Watch 3 ou mais antigo (Tizen):** exporte os dados do Samsung Health e importe na aba **Noites** do app. O Maré combina os estágios e a FC do relógio com a noite medida pelo celular e mostra o que o relógio marcava na hora do despertar.
- **Galaxy Watch 4 ou mais novo:** instale `Mare-relogio.apk`. Mede movimento no pulso e frequência cardíaca, vibra no pulso na hora de acordar e envia a noite ao celular por Bluetooth.

## Importar do Samsung Health

1. No Samsung Health do celular: menu ☰ → Configurações → **Baixar dados pessoais** → Baixar.
2. Os arquivos vão para `Download/Samsung Health/` no celular.
3. No app Meus Arquivos, segure a pasta mais recente e toque em **Compactar**.
4. No Maré, aba **Noites** → **Importar** → escolha o `.zip`.

Para ter FC minuto a minuto durante o sono, deixe a frequência cardíaca do relógio em "Medir continuamente".

## Instalar no relógio (Watch 4 ou mais novo)

1. Relógio: Configurações → Sobre o relógio → Software → toque 5× em "Versão do software".
2. Opções do desenvolvedor: ative "Depuração ADB" e "Depurar por Wi-Fi" (relógio e celular no mesmo Wi-Fi).
3. No celular, use um instalador ADB (Bugjaeger ou Wear Installer), pareie com o código mostrado no relógio e envie o `Mare-relogio.apk`.
4. Abra o Maré no relógio e permita sensores, Bluetooth e notificações.

## Como funciona

Épocas de 30 s. Sono × vigília por média ponderada no estilo Cole-Kripke. Ciclos pelas viradas de posição a cada ~70–120 min. Com o relógio, a frequência cardíaca separa profundo (FC baixa e estável) de REM (FC alta e oscilante). O alarme toca no primeiro movimento dentro da janela; sem movimento, no horário limite.

Estágios são estimativa e não substituem polissonografia. A aba **Ciência** do app traz o mecanismo e as referências.

## Código

- `fonte/web/` — app do celular. `python3 build.py` gera `dist/` (copie o conteúdo para a raiz do repositório).
- `fonte/relogio/` — app Wear OS em Java, sem Gradle. `build.sh` compila com o Android SDK (build-tools 35, platform 35).
