# Política de segurança

## Versões suportadas

O levedit é um site estático publicado a partir da branch `main`. Só a versão atual
(https://paixaodev.github.io/levedit/) recebe correções.

## Como reportar uma vulnerabilidade

**Não abra uma issue pública.** Use o reporte privado do GitHub:

1. Vá em [Security → Report a vulnerability](https://github.com/paixaoDev/levedit/security/advisories/new).
2. Descreva o problema, os passos para reproduzir e o impacto. Um `.level.json` ou um arquivo GLB/GLTF de
   exemplo ajuda muito.

Você deve receber uma resposta em até 7 dias. Se a falha for confirmada, a correção sai o quanto antes e você
recebe crédito no aviso de segurança, se quiser.

## O que conta como vulnerabilidade

O editor roda só no navegador, sem backend e sem contas. Os pontos sensíveis são principalmente os arquivos
que o usuário abre:

- Um `.level.json` ou modelo GLB/GLTF malicioso que execute código (XSS) ao ser aberto
- Algo que vaze dados do navegador do usuário para terceiros
- Dependências vendorizadas (`vendor/`) com falhas conhecidas

Travamentos causados por arquivos gigantes ou malformados são bugs comuns: abra uma issue normal.
