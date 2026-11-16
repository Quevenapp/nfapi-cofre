# Cofre NFapi

O cofre é o emissor de notas fiscais do [NFapi](https://github.com/Quevenapp/nfapi). Ele roda na **sua** conta Cloudflare: guarda o certificado digital A1, expõe a API que os seus sistemas chamam para emitir, monta e assina os documentos, fala com o governo (SEFAZ e NFS-e Nacional) e arquiva os XML. Não há serviço intermediário.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Quevenapp/nfapi/tree/main/vault)

## O que é criado na sua conta

| Recurso | Para quê |
|---|---|
| Worker `nfapi-cofre` | A API de emissão (`/v1/...`) e o painel do emitente (`/setup`) |
| Container | Conexão mTLS com o governo (os servidores das SEFAZ usam certificados ICP-Brasil, que o Workers sozinho não aceita) |
| Banco D1 `nfapi-cofre` | Certificado cifrado, chaves de API, emissões, numeração, auditoria e índice dos documentos |
| Bucket R2 `nfapi-cofre-docs` | XML autorizados, eventos e o diário de transmissões |

O Container exige o plano **Workers Paid** (US$ 5/mês) na sua conta Cloudflare.

## Instalação

O passo a passo completo, com gerador do segredo, está em **<https://nfapi.queven.app/instalar>**. Em resumo:

1. Gere o segredo do cofre (`VAULT_SECRET`) na página acima, ou com o comando abaixo, e guarde-o em local seguro:

   ```bash
   openssl rand -hex 32
   ```

   Ele cifra o certificado e é a senha do painel. Se for perdido, será preciso reinstalar o certificado.
2. Clique em **Deploy to Cloudflare**. No campo `VAULT_SECRET`, apague o que o navegador tiver preenchido sozinho e cole o segredo. Deixe **Proteger com Cloudflare Access** desligado.
3. Abra `https://<seu-cofre>/setup`, entre com o segredo e:
   - envie o arquivo `.pfx` do certificado A1 e a senha dele;
   - rode o **teste de conexão**, que consulta os serviços de homologação;
   - crie uma **chave de API** para cada sistema que vai emitir.

A produção começa **bloqueada**: o cofre só emite em homologação até você liberar no painel.

## API

Todas as chamadas levam a chave de API em `Authorization: Bearer nfapi_...`.

| Rota | O que faz |
|---|---|
| `POST /v1/nfse` | Emite uma NFS-e |
| `GET /v1/nfse` | Lista as emissões |
| `GET /v1/nfse/:id` | Consulta uma emissão |
| `GET /v1/nfse/:id/xml` | Baixa o XML da NFS-e autorizada |
| `POST /v1/nfse/:id/cancelar` | Cancela a NFS-e |

```bash
curl -X POST https://SEU-COFRE.workers.dev/v1/nfse \
  -H "Authorization: Bearer nfapi_SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{
    "ambiente": "homologacao",
    "referencia": "pedido-1001",
    "prestador": { "codigoMunicipio": "3550308", "regimeTributario": { "simplesNacional": "me_epp", "apuracaoSimples": 1 } },
    "tomador": { "cnpj": "99888777000166", "nome": "Cliente Ltda" },
    "servico": { "codigoMunicipioPrestacao": "3550308", "codigoTributacaoNacional": "010701", "descricao": "Suporte técnico" },
    "valores": { "servico": 1500 },
    "tributacao": { "issqn": { "aliquota": 2 }, "totalTributos": { "tipo": "percentual_simples", "percentual": 6 } }
  }'
```

- **`ambiente`**: `homologacao` (padrão) ou `producao`.
- **`referencia`**: o identificador do pedido no seu sistema. Reenviar a mesma referência nunca gera duas notas; se a primeira tentativa ficou sem resposta do governo, o cofre consulta antes de reenviar.
- A numeração da DPS é controlada pelo cofre, por série. O emitente é sempre o titular do certificado instalado.
- Erros vêm como `{ "erro": { "codigo": "...", "mensagem": "..." } }`. Quando o governo rejeita a nota, o corpo traz também a emissão, com as mensagens recebidas.
- Uma chave criada como **somente homologação** nunca emite nem cancela em produção, mesmo com a produção liberada.

Cancelamento:

```bash
curl -X POST https://SEU-COFRE.workers.dev/v1/nfse/ID_DA_EMISSAO/cancelar \
  -H "Authorization: Bearer nfapi_SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{ "motivo": "erro_emissao", "justificativa": "Nota emitida com o valor incorreto" }'
```

Os campos aceitos estão em [`src/nfse/schema.ts`](src/nfse/schema.ts).

## Atualização

O governo muda regras, endereços e leiautes com frequência. As correções são publicadas no canal estável do NFapi (branch `cofre-estavel`), e o painel avisa quando há uma versão nova.

Para atualizar com um clique, crie o gatilho uma única vez:

1. No painel do Cloudflare, abra **Workers & Pages** e selecione o Worker do cofre.
2. Em **Settings > Builds > Deploy Hooks**, crie um gatilho para a branch `main`.
3. Cole a URL gerada na seção **Atualização** do painel do cofre.

O botão **Atualizar** dispara um build no Cloudflare. No começo do build, [`tools/atualizar.mjs`](tools/atualizar.mjs) baixa a versão publicada e a instala por cima; o nome do Worker, o banco, o bucket e tudo o que está guardado neles são preservados. Sem o gatilho, o mesmo resultado se obtém refazendo o deploy pelo painel do Cloudflare.

A atualização instala código publicado em `Quevenapp/nfapi`, que é aberto e pode ser conferido antes. Ela só acontece quando você dispara. Quem mantém um fork próprio pode desligá-la com a variável de build `NFAPI_ATUALIZAR=0`, ou apontar para outro repositório com `NFAPI_REPO` e `NFAPI_CANAL`.

## Segurança

- O certificado é gravado cifrado (AES-GCM) com chave derivada do `VAULT_SECRET`; a senha do `.pfx` não é guardada.
- O cofre só assina documentos cujo emitente é o titular do certificado e só transmite para endereços `*.gov.br`.
- As chaves de API são guardadas como hash; o valor aparece uma única vez, na criação, e cada chave pode ser revogada no painel.
- Toda troca com o governo fica gravada no seu R2, e toda operação, na trilha de auditoria.
- A URL do gatilho de atualização fica cifrada no cofre.

## Desenvolvimento

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm dev
```

`pnpm testar-certificado caminho/certificado.pfx` verifica, nesta máquina, se um certificado A1 é aceito pelos serviços de homologação.
