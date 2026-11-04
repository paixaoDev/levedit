# Como contribuir com o levedit

Obrigado pelo interesse! O levedit é um editor de levels 3D que roda 100% no navegador, sem backend e sem build.
Este guia explica como reportar problemas, sugerir ideias e mandar código.

Ao participar, você concorda em seguir o [Código de Conduta](CODE_OF_CONDUCT.md).

## Antes de começar

- **Achou um bug?** Procure nas [issues](https://github.com/paixaoDev/levedit/issues) se ele já foi reportado.
  Se não, abra uma usando o modelo **Bug**.
- **Tem uma ideia?** Abra uma issue com o modelo **Sugestão de funcionalidade** antes de escrever código.
  Assim a gente alinha o escopo e você não perde tempo com algo que não vai entrar.
- **Dúvida de uso?** Use as [Discussions](https://github.com/paixaoDev/levedit/discussions) (se estiverem
  ativas) ou abra uma issue com o modelo **Pergunta**.
- **Falha de segurança?** Não abra issue pública. Siga o [SECURITY.md](SECURITY.md).

Issues marcadas com `good first issue` são um bom ponto de partida.

## Regras para abrir issues

1. Uma issue por problema ou ideia.
2. Use sempre um dos modelos; issues em branco ficam desativadas.
3. Título curto e específico: "Parede some ao girar corredor em 90°" é melhor que "bug na parede".
4. Para bugs, inclua passos para reproduzir, o que esperava, o que aconteceu, navegador e sistema.
   Se puder, anexe o `.level.json` (menu Arquivo → Salvar) e um print ou vídeo.
5. Escreva em português ou inglês.
6. Issues sem resposta do autor por 30 dias depois de um pedido de informação podem ser fechadas.

## Rodando localmente

Não há dependências para instalar. Você só precisa de um servidor estático (módulos ES não abrem via `file://`)
e do Node.js 20+ para os testes.

```bash
git clone https://github.com/<seu-usuario>/levedit.git
cd levedit
python3 -m http.server 8000      # ou: npx serve .
# abra http://localhost:8000

node --test tests/*.test.mjs     # testes
```

A estrutura de pastas está descrita no [README](README.md#estrutura).

## Fluxo de pull request

1. Faça um fork e crie uma branch a partir da `main` com um nome descritivo:
   `fix/parede-girada`, `feat/area-circular`, `docs/atalhos`.
2. Faça mudanças pequenas e focadas. Uma PR resolve uma coisa só.
3. Rode os testes (`node --test tests/*.test.mjs`) e teste a mudança no navegador.
4. Abra a PR para a `main` preenchendo o modelo. Ligue a issue com `Closes #123`.
5. A PR precisa de **CI verde** e **1 aprovação** do mantenedor para entrar.
   Ela é integrada com *squash merge*, então o título da PR vira a mensagem do commit.
6. Responda aos comentários da revisão com novos commits na mesma branch (não precisa reescrever o histórico).

### Padrão de commits e títulos de PR

Use [Conventional Commits](https://www.conventionalcommits.org/pt-br/) no título da PR:

```
<tipo>(<escopo opcional>): <descrição no imperativo>
```

| Tipo | Quando usar |
|---|---|
| `feat` | funcionalidade nova |
| `fix` | correção de bug |
| `docs` | só documentação |
| `refactor` | mudança de código sem mudar comportamento |
| `perf` | melhoria de desempenho |
| `test` | testes novos ou corrigidos |
| `style` | CSS/visual sem mudar comportamento |
| `chore` | manutenção, CI, vendor |

Exemplos: `feat(areas): área circular com centro e raio`, `fix(walls): parede não some ao sobrepor corredor`.

## Padrões de código

- JavaScript moderno com módulos ES (`import`/`export`), sem build e sem TypeScript.
- **Sem dependências novas** sem discutir antes numa issue. O Three.js fica vendorizado em `vendor/` (r160);
  não use CDN.
- Indentação de 2 espaços, ponto e vírgula, aspas simples.
- Lógica pura (matemática, geometria, regras de junção) deve ficar fora do Three.js quando possível e ganhar
  teste em `tests/`.
- Textos da interface em português.
- Mantenha o visual CAD do editor: fundo branco, linhas bege escuro, interface limpa.
- Mudança de comportamento visível ao usuário deve atualizar o README.

### Regras do editor que não podem quebrar

- Corredores e áreas não têm vãos aleatórios: só abrem onde outro corredor ou área se conecta.
- Paredes sobrepostas nunca somem nem se atravessam; o corredor editado por último encosta na face do outro.
- O formato `.level.json` deve continuar abrindo levels salvos em versões anteriores.

## Licença

Ao contribuir, você concorda que seu código será distribuído sob a [GNU GPL v3](LICENSE), a licença do projeto.
