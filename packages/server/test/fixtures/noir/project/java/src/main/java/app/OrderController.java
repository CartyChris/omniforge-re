package app;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/orders")
public class OrderController {
  @GetMapping("/{id}") public String get(@PathVariable String id) { return id; }
  @DeleteMapping("/{id}") public void delete(@PathVariable String id) {}
}
