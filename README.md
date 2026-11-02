# levedit

Editor de levels 3D para a web, feito com [Three.js](https://threejs.org). Serve para criar e testar
mockups de fases (plantas baixas e cenários top-down) para devs de jogos: simples de usar, procedural por dentro.
Visual de CAD, branco com linhas bege escuro.

Roda 100% no navegador, sem backend e sem build: é um site estático pronto para o GitHub Pages.

## Rodando

```bash
# qualquer servidor estático serve (módulos ES não abrem via file://)
python3 -m http.server 8000
# abra http://localhost:8000
```

### GitHub Pages

O workflow `.github/workflows/pages.yml` publica o site a cada push na `main`.
Uma vez só: em **Settings → Pages → Build and deployment**, escolha **Source: GitHub Actions**.

## O que tem

**Curvas e paredes procedurais**
- **Corredor (C)**: clique para criar pontos; o piso e as paredes dos dois lados nascem sozinhos ao longo da curva.
- **Parede (W)** e **Área (A)** (sala/praça fechada com piso e paredes no contorno).
- Edição por pontos: arraste os quadrados; arraste o losango no meio de um trecho para criar um ponto novo
  (é assim que se "puxa" a curva pelo centro); botão direito/Alt+clique remove o ponto.
- **Curvatura** 0 = cantos vivos, >0 = Catmull-Rom. Offsets com miter mantêm a largura constante nas curvas.
- **Ramificação**: comece ou termine um corredor sobre outro e a parede do outro abre ali, com porta (batente + verga),
  abertura livre ou sem abertura. Corredores não têm vãos aleatórios: só abrem onde existe saída.
  Ao arrastar a ponta (ou desenhar) perto de outro corredor, um anel laranja mostra onde ela vai se conectar
  ("Conectar ao nó", "Novo nó" ou "Emendar"), e os nós próximos aparecem como bolinhas.
- **Áreas e portas**: termine um corredor dentro ou na borda de uma área e a parede da área abre ali (porta,
  abertura ou nada). Áreas encostadas ganham uma porta no meio da parede em comum (largura ajustável).
  Áreas também não têm vãos aleatórios.
- **Largura por nó**: cada nó tem alças nas quinas esquerda/direita para engordar/afinar o corredor só naquele ponto.
  Ao engordar, a parede para ao encostar em outro corredor, parede ou área (Alt atravessa).
- **Grupos**: Shift+clique em vários corredores e **Ctrl+G** agrupa (estilo compartilhado: paredes, piso, regras,
  decoração) e conecta as pontas mais próximas ao primeiro selecionado. Ctrl+Shift+G desagrupa.
- **Regras procedurais** por objeto: semente, chance e tamanho de vãos (portas/ruínas), variação de altura,
  irregularidade (jitter lateral), tamanho do segmento e modo contínuo/blocos. Presets: Limpo, Ruínas, Orgânico,
  Muralha, Com portas.
- **Decoração** ao longo das bordas: canteiro de flores, pedras, calçada, pilares, cerca viva, caixas e postes.

**Verticalidade**
- **Níveis** funcionam como layers com elevação (acima/abaixo), visibilidade e modo fantasma para os outros níveis.
- Um corredor pode **terminar em outro nível**: a própria curva sobe/desce como rampa suave ou em degraus.
- **Escada/Rampa (S)** liga o nível ativo ao de cima.

**Assets**
- Biblioteca procedural (cubo, cilindro, rampa, plataforma, pilar, arco, caixa, barril, pedra, árvore, arbusto,
  banco, poste, cerca, carro, porta).
- **Importar GLB/GLTF**: o modelo entra no mesmo material do editor e só muda de cor.
- Todos os objetos usam o mesmo material; só a cor muda.

**Agentes e modo de teste (▶ Testar)**
- Player com 3 gameplays customizáveis: **FPS** (mouse travado, tiro hitscan), **Plataforma** (terceira pessoa,
  pulo duplo, pisão nos inimigos) e **Carro** (arcade com drift e freio de mão).
- Inimigos: **Atirador FPS** (atira projéteis quando te vê), **Arcade** (persegue e causa dano por contato) e
  **Carro** (persegue/patrulha e atropela). Comportamentos: parado, vagar, patrulhar um caminho (corredor/parede/área)
  ou perseguir.
- Física simples por raycast: sobe degraus, rampas e escadas, colide com paredes e assets.

**Arquivo**
- Autosave no navegador, desfazer/refazer, salvar/abrir `.level.json`, exportar a cena em **GLB** e capturar **PNG**.

## Atalhos

| Tecla | Ação | Tecla | Ação |
|---|---|---|---|
| V | Selecionar | T | Alternar 3D / Planta |
| C | Corredor | G | Ímã na grade |
| W | Parede | F | Focar seleção |
| A | Área | R / Shift+R | Girar 15° |
| S | Escada/rampa | Del | Excluir |
| O | Asset | Ctrl+D | Duplicar |
| P | Agente | Ctrl+Z / Ctrl+Shift+Z | Desfazer / refazer |
| PgUp/PgDn | Trocar nível | Ctrl+Enter | Testar |
| Shift+clique | Somar à seleção | Ctrl+G / Ctrl+Shift+G | Agrupar / desagrupar |

Câmera: arraste no vazio (ou botão direito) para girar, botão do meio ou Shift+arrastar para mover, roda para zoom.

## Estrutura

```
index.html, style.css      interface
src/math/curve.js          curvas, amostragem por arco, frames com miter, offsets (sem Three.js, testável)
src/builders/              geração procedural: corredores, paredes, áreas, decoração, conectores, assets, agentes
src/render/                material único + contorno CAD, geometrias (faixas, lajes)
src/editor/                viewport, câmeras, grid e ferramentas
src/play/                  física por raycast, player e inimigos
src/ui/                    painéis de níveis, objetos e propriedades
vendor/                    Three.js r160 (local, sem CDN)
tests/                     testes da matemática de curvas (node --test tests/*.test.mjs)
```

O formato do level é JSON simples (`levels`, `objects`, `settings`, `customAssets`), fácil de ler em qualquer engine.
