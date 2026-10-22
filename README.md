# Maré — despertador de ciclo

Acompanha o sono pelo celular e acorda você no sono leve, dentro de uma janela antes do horário limite.

**Abrir:** https://renatoavalanche2003.github.io/APP-de-rel-gio/ no Chrome do celular, depois "Adicionar à tela inicial".

## O que faz

- **Noite:** você define "acordar até" e uma janela de 10–45 min. Dentro da janela, o alarme toca no primeiro movimento de sono leve; sem movimento, toca no horário limite.
- **Cochilo:** 10, 20 ou 90 min, contados a partir de quando você pega no sono.
- **Tarefa para desligar:** contas, sacudir o celular, jogo de memória ou andar alguns passos, em três níveis. O som baixa durante a tarefa e volta se você parar. Soneca pode ser desligada.
- **Relatório:** hipnograma, latência, eficiência, ciclos, ronco e sonolência ao acordar (escala de Karolinska), com análise da noite e PDF para baixar.
- **Evolução:** gráfico que cresce a cada noite com o tempo em cada estágio (em horas) e linhas de sono total, REM, profundo, latência, tempo acordado, eficiência e sonolência. Tem PDF do período.
- **Análise e dicas:** padrões das últimas 7 noites (duração, regularidade, latência, fragmentação, ronco, despertar, sono diurno), cada dica com mecanismo, o que fazer e a fonte.

## Como usar à noite

- Celular na tomada, sobre o colchão perto do travesseiro, tela para baixo. A tela fica ligada em preto a noite toda.
- Volume alto e "Não perturbe" ligado.
- Mantenha um despertador comum 5 min depois do limite: se o navegador fechar, ele te salva.

## Como funciona

Acelerômetro e microfone em épocas de 30 s. Sono × vigília por média ponderada no estilo Cole-Kripke. Ciclos pelas viradas de posição a cada ~70–120 min. Ronco separado de ruídos isolados pelo ritmo. Profundo e REM são inferidos pela posição no ciclo e não substituem polissonografia. A aba **Ciência** do app traz o mecanismo e as referências.

## Código

`fonte/web/` tem o código. `python3 build.py` gera `dist/`; copie o conteúdo para a raiz do repositório.

A versão com o app do Galaxy Watch (Wear OS) e a importação do Samsung Health está guardada no ramo `relogio`.
