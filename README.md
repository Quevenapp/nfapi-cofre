# Cofre NFapi

O cofre é a parte do [NFapi](https://github.com/Quevenapp/nfapi) que roda na **sua** conta Cloudflare. Ele guarda o seu certificado digital A1, assina os documentos fiscais, fala com os serviços do governo (SEFAZ e NFS-e Nacional) e arquiva os XML. A API do NFapi nunca recebe o certificado nem armazena as notas.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Quevenapp/nfapi/tree/main/vault)

## O que é criado na sua conta

| Recurso | Para quê |
|---|---|
| Worker `nfapi-cofre` | Tela `/setup` e as operações de assinar, transmitir e arquivar |
| Container | Conexão mTLS com o governo (os servidores das SEFAZ usam certificados ICP-Brasil, que o Workers sozinho não aceita) |
| Banco D1 `nfapi-cofre` | Certificado cifrado, pareamento, auditoria e índice dos documentos |
| Bucket R2 `nfapi-cofre-docs` | XML autorizados e o diário de transmissões |

O Container exige o plano **Workers Paid** (US$ 5/mês) na sua conta Cloudflare.

## Instalação

O passo a passo completo, com gerador do segredo, está em **<https://nfapi.queven.app/instalar>**. Em resumo:

1. Gere o segredo do cofre (`VAULT_SECRET`) na página acima, ou com o comando abaixo, e guarde-o em local seguro:

   ```bash
   openssl rand -hex 32
   ```

   Ele cifra o certificado e é a senha da tela de configuração. Se for perdido, será preciso reinstalar o certificado.
2. Clique em **Deploy to Cloudflare**. No campo `VAULT_SECRET`, apague o que o navegador tiver preenchido sozinho e cole o segredo. Deixe **Proteger com Cloudflare Access** desligado.
3. Abra `https://<seu-cofre>/setup`, entre com o segredo e:
   - envie o arquivo `.pfx` do certificado A1 e a senha dele;
   - rode o **teste de conexão**, que consulta os serviços de homologação;
   - gere o **código de pareamento** e envie-o à API do NFapi (`POST /v1/emitentes`).

A produção começa **bloqueada**: o cofre só assina documentos de homologação até você liberar na tela `/setup`.

## Segurança

- O certificado é gravado cifrado (AES-GCM) com chave derivada do `VAULT_SECRET`; a senha do `.pfx` não é guardada.
- O cofre só assina documentos cujo emitente é o titular do certificado e só transmite para endereços `*.gov.br`.
- Toda troca com o governo fica gravada no seu R2, e toda operação, na trilha de auditoria.
- Você pode revogar o acesso da API a qualquer momento, na tela `/setup`.

## Desenvolvimento

```bash
pnpm install
pnpm test
pnpm dev
```

`pnpm testar-certificado caminho/certificado.pfx` verifica, nesta máquina, se um certificado A1 é aceito pelos serviços de homologação.
