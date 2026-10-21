<script lang="ts">
  let count = $state(0)
  const doubled = $derived(count * 2)

  doubled = 4

  const bad = $style({
    display: "grid",
    zIndex: 10
  })

  function poke() {
    document.querySelector('main')
  }
</script>

<main class="app" style={bad}>
  {#each [1, 2, 3] as item}
    <span>{item}</span>
  {/each}
  <img />
</main>
