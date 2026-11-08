#ifndef GRAPHY_CORE_H
#define GRAPHY_CORE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
uint32_t graphy_core_abi_version(void);
/* Borrowed NUL-terminated UTF-8 JSON request; owned NUL-terminated JSON response. */
char *graphy_core_call(const char *input);
/* Frees one response returned by graphy_core_call; NULL is accepted. */
void graphy_core_free(char *output);
/* Blocking full backend entry. arguments is a JSON array of CLI strings; returns exit code. */
int graphy_backend_main(const char *arguments);
#ifdef __cplusplus
}
#endif
#endif
